import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db, schema } from "../db/client";
import { env } from "../env";
import { newToken, sha256, safeEqual } from "../lib/crypto";
import { escapeHtml } from "../lib/emails";

/**
 * OAuth 2.1 authorization server for the MCP server, per the MCP auth spec:
 * authorization-code + PKCE (S256) for public clients, dynamic client
 * registration (RFC 7591), AS metadata (RFC 8414). Access + refresh tokens are
 * stored hashed in mcp_tokens, so the admin portal's revoke list governs them.
 *
 * The consent page rides on the app's session cookie — if you're signed in to
 * invite.scottylabs.org you just click Approve; otherwise you do the normal
 * magic-link sign-in first and land back here.
 */

const ACCESS_TTL_S = 7 * 24 * 3600; // 7 days
const REFRESH_TTL_S = 90 * 24 * 3600; // 90 days
const CODE_TTL_MS = 5 * 60 * 1000;

export function authServerMetadata() {
  return {
    issuer: env.appUrl,
    authorization_endpoint: `${env.appUrl}/api/oauth/authorize`,
    token_endpoint: `${env.appUrl}/api/oauth/token`,
    registration_endpoint: `${env.appUrl}/api/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["invites:read"],
  };
}

function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function redirectUriAllowed(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:") return true;
    if (u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]")) return true;
    return false;
  } catch {
    return false;
  }
}

function cors(reply: { header: (k: string, v: string) => unknown }) {
  reply.header("Access-Control-Allow-Origin", "*");
  reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization, mcp-protocol-version");
  reply.header("Access-Control-Max-Age", "86400");
}

export async function registerOauthRoutes(app: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------- discovery
  for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"]) {
    app.get(path, async (_req, reply) => {
      cors(reply);
      return reply.send(authServerMetadata());
    });
    app.options(path, async (_req, reply) => {
      cors(reply);
      return reply.status(204).send();
    });
  }

  // ------------------------------------------------------------- registration
  app.options("/api/oauth/register", async (_req, reply) => {
    cors(reply);
    return reply.status(204).send();
  });
  app.post("/api/oauth/register", async (request, reply) => {
    cors(reply);
    const body = (request.body ?? {}) as {
      redirect_uris?: string[];
      client_name?: string;
      token_endpoint_auth_method?: string;
    };
    const uris = (body.redirect_uris ?? []).filter((u) => typeof u === "string").slice(0, 10);
    if (uris.length === 0 || !uris.every(redirectUriAllowed)) {
      return reply.status(400).send({ error: "invalid_redirect_uri", error_description: "https (or localhost http) redirect_uris required" });
    }
    const clientId = randomUUID();
    const name = (body.client_name ?? "MCP client").slice(0, 120);
    await db.insert(schema.oauthClients).values({ clientId, name, redirectUris: uris });
    return reply.status(201).send({
      client_id: clientId,
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  // ------------------------------------------------------------- authorize
  app.get("/api/oauth/authorize", async (request, reply) => {
    const q = request.query as Record<string, string | undefined>;
    const clientId = q.client_id ?? "";
    const redirectUri = q.redirect_uri ?? "";
    const state = q.state ?? "";
    const codeChallenge = q.code_challenge ?? "";
    const resource = q.resource;

    const client = (await db.select().from(schema.oauthClients).where(eq(schema.oauthClients.clientId, clientId)))[0];
    if (!client) return reply.status(400).send({ error: "invalid_client", error_description: "Unknown client_id" });
    if (!client.redirectUris.includes(redirectUri)) {
      return reply.status(400).send({ error: "invalid_request", error_description: "redirect_uri not registered" });
    }

    const bounce = (error: string, description: string) => {
      const u = new URL(redirectUri);
      u.searchParams.set("error", error);
      u.searchParams.set("error_description", description);
      if (state) u.searchParams.set("state", state);
      return reply.redirect(u.toString());
    };

    if ((q.response_type ?? "") !== "code") return bounce("unsupported_response_type", "Only response_type=code is supported");
    if (!codeChallenge || (q.code_challenge_method ?? "") !== "S256") return bounce("invalid_request", "PKCE with S256 is required");

    // Needs the app session — bounce through the normal sign-in and come back.
    const ctx = request.authCtx;
    if (!ctx) {
      const here = `/api/oauth/authorize?${new URLSearchParams(q as Record<string, string>).toString()}`;
      return reply.redirect(`${env.appUrl}/signin?to=${encodeURIComponent(here)}`);
    }

    if (!ctx.admin) {
      reply.header("Content-Type", "text/html; charset=utf-8");
      return reply.send(consentShell(`
<div style="font-size:17px;font-weight:700;letter-spacing:-0.02em;color:#1e1e1e">Organizers only</div>
<p style="margin:12px 0 0;font-size:14px;line-height:1.55;color:#5f6f7f"><span style="font-family:Menlo,Consolas,monospace;font-size:12.5px">${escapeHtml(ctx.user.email)}</span> isn't an organizer on ScottyLabs Invites, so there's no guest data to share. Ask a super admin for an invite, then try connecting again.</p>`));
    }

    const scope = ctx.admin.row.role === "super_admin" ? "all" : ctx.admin.row.committeeId;
    const scopeName = ctx.admin.row.role === "super_admin" ? "all committees" : `the ${ctx.admin.committee.name} committee`;

    reply.header("Content-Type", "text/html; charset=utf-8");
    reply.header("Cache-Control", "no-store");
    const fields = Object.entries({ ...q, scope })
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(String(v))}">`)
      .join("");
    return reply.send(consentShell(`
<div style="font-size:17px;font-weight:700;letter-spacing:-0.02em;color:#1e1e1e">Connect ${escapeHtml(client.name)}?</div>
<p style="margin:12px 0 0;font-size:14px;line-height:1.55;color:#5f6f7f">It will read guest data for <b style="color:#1e1e1e">${escapeHtml(scopeName)}</b> as <span style="font-family:Menlo,Consolas,monospace;font-size:12.5px;color:#38424b">${escapeHtml(ctx.user.email)}</span> — events, guest lists, pending reviews, CSV exports. You can revoke it any time from the Admin portal.</p>
<form method="POST" action="/api/oauth/authorize/decision" style="margin:22px 0 0;display:flex;flex-direction:column;gap:10px">
${fields}
<button type="submit" name="decision" value="approve" style="width:100%;border:none;cursor:pointer;background:#0e96d1;color:#fff;font-size:15px;font-weight:600;font-family:inherit;padding:13px 0;border-radius:100px">Approve access</button>
<button type="submit" name="decision" value="deny" style="width:100%;cursor:pointer;background:#fff;color:#1e1e1e;border:1px solid #9eb1c2;font-size:14px;font-weight:600;font-family:inherit;padding:11px 0;border-radius:100px">Deny</button>
</form>`));
  });

  app.post("/api/oauth/authorize/decision", async (request, reply) => {
    const b = (request.body ?? {}) as Record<string, string | undefined>;
    const ctx = request.authCtx;
    if (!ctx?.admin) return reply.status(401).send({ error: "unauthorized" });

    const client = (await db.select().from(schema.oauthClients).where(eq(schema.oauthClients.clientId, b.client_id ?? "")))[0];
    if (!client || !client.redirectUris.includes(b.redirect_uri ?? "")) {
      return reply.status(400).send({ error: "invalid_request" });
    }
    const u = new URL(b.redirect_uri!);
    if (b.state) u.searchParams.set("state", b.state);

    if (b.decision !== "approve") {
      u.searchParams.set("error", "access_denied");
      return reply.redirect(u.toString());
    }

    // Scope is re-derived server-side — never trusted from the form.
    const scope = ctx.admin.row.role === "super_admin" ? "all" : ctx.admin.row.committeeId;
    const code = newToken(24);
    await db.insert(schema.oauthCodes).values({
      codeHash: sha256(code),
      clientId: client.clientId,
      redirectUri: b.redirect_uri!,
      codeChallenge: b.code_challenge ?? "",
      email: ctx.user.email,
      scope,
      resource: b.resource ?? null,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    });
    u.searchParams.set("code", code);
    return reply.redirect(u.toString());
  });

  // ------------------------------------------------------------- token
  app.options("/api/oauth/token", async (_req, reply) => {
    cors(reply);
    return reply.status(204).send();
  });
  app.post("/api/oauth/token", async (request, reply) => {
    cors(reply);
    reply.header("Cache-Control", "no-store");
    const b = (request.body ?? {}) as Record<string, string | undefined>;
    const fail = (code: number, error: string, description: string) =>
      reply.status(code).send({ error, error_description: description });

    if (b.grant_type === "authorization_code") {
      if (!b.code || !b.code_verifier || !b.client_id || !b.redirect_uri) {
        return fail(400, "invalid_request", "code, code_verifier, client_id and redirect_uri are required");
      }
      const rows = await db.select().from(schema.oauthCodes).where(eq(schema.oauthCodes.codeHash, sha256(b.code)));
      const authz = rows[0];
      if (!authz || authz.consumedAt || authz.expiresAt < new Date()) return fail(400, "invalid_grant", "Code is invalid or expired");
      if (authz.clientId !== b.client_id || authz.redirectUri !== b.redirect_uri) return fail(400, "invalid_grant", "Client mismatch");
      if (!safeEqual(s256(b.code_verifier), authz.codeChallenge)) return fail(400, "invalid_grant", "PKCE verification failed");

      const consumed = await db
        .update(schema.oauthCodes)
        .set({ consumedAt: new Date() })
        .where(and(eq(schema.oauthCodes.id, authz.id), isNull(schema.oauthCodes.consumedAt)))
        .returning();
      if (consumed.length === 0) return fail(400, "invalid_grant", "Code already used");

      const client = (await db.select().from(schema.oauthClients).where(eq(schema.oauthClients.clientId, authz.clientId)))[0];
      const accessToken = newToken();
      const refreshToken = newToken();
      await db.insert(schema.mcpTokens).values({
        tokenHash: sha256(accessToken),
        refreshTokenHash: sha256(refreshToken),
        email: authz.email,
        scope: authz.scope,
        label: client?.name ?? "MCP client",
        clientId: authz.clientId,
        expiresAt: new Date(Date.now() + ACCESS_TTL_S * 1000),
        refreshExpiresAt: new Date(Date.now() + REFRESH_TTL_S * 1000),
      });
      return reply.send({
        access_token: accessToken,
        token_type: "bearer",
        expires_in: ACCESS_TTL_S,
        refresh_token: refreshToken,
        scope: "invites:read",
      });
    }

    if (b.grant_type === "refresh_token") {
      if (!b.refresh_token) return fail(400, "invalid_request", "refresh_token is required");
      const now = new Date();
      const rows = await db
        .select()
        .from(schema.mcpTokens)
        .where(and(eq(schema.mcpTokens.refreshTokenHash, sha256(b.refresh_token)), isNull(schema.mcpTokens.revokedAt)));
      const row = rows[0];
      if (!row || !row.refreshExpiresAt || row.refreshExpiresAt < now) return fail(400, "invalid_grant", "Refresh token is invalid or expired");
      if (b.client_id && row.clientId && b.client_id !== row.clientId) return fail(400, "invalid_grant", "Client mismatch");

      // Rotate both tokens in place — the admin-portal row (and its revocation) is stable.
      const accessToken = newToken();
      const refreshToken = newToken();
      await db
        .update(schema.mcpTokens)
        .set({
          tokenHash: sha256(accessToken),
          refreshTokenHash: sha256(refreshToken),
          expiresAt: new Date(Date.now() + ACCESS_TTL_S * 1000),
          lastUsedAt: now,
        })
        .where(eq(schema.mcpTokens.id, row.id));
      return reply.send({
        access_token: accessToken,
        token_type: "bearer",
        expires_in: ACCESS_TTL_S,
        refresh_token: refreshToken,
        scope: "invites:read",
      });
    }

    return fail(400, "unsupported_grant_type", "Use authorization_code or refresh_token");
  });
}

function consentShell(inner: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Authorize — ScottyLabs Invites</title></head>
<body style="margin:0;background:#f0f4f8;font-family:Inter,Helvetica,Arial,sans-serif;display:flex;align-items:flex-start;justify-content:center;min-height:100vh">
<div style="margin-top:12vh;width:100%;max-width:420px;background:#fff;border:1px solid #c7d2dc;border-radius:16px;box-shadow:0 2px 8px rgba(30,30,30,0.08);padding:32px 28px;box-sizing:border-box">
<div style="font-size:15px;font-weight:700;letter-spacing:-0.02em;color:#1e1e1e;margin-bottom:18px">ScottyLabs <span style="color:#0e96d1">Invites</span> · MCP</div>
${inner}
<p style="margin:18px 0 0;font-size:11.5px;color:#7a8fa3">Tokens are committee-scoped and listed under Admin → MCP data access.</p>
</div></body></html>`;
}
