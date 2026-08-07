import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db/client";
import { env } from "../env";
import { sha256 } from "../lib/crypto";
import { findAdminByEmail } from "../auth/service";
import { toCsv } from "../lib/csv";
import { fmtLongDate, fmtTimeRange } from "../lib/format";
import { authServerMetadata } from "../oauth/routes";

interface McpAuth {
  email: string;
  scope: string; // "all" or committee id
  scopeName: string;
}

/**
 * Validates a bearer token on every request: hash lookup, not revoked, not
 * expired, and the owner must still be an organizer — revoking an admin in
 * the portal cuts their MCP access immediately, not at token expiry.
 */
async function authFromBearer(header: string | undefined): Promise<McpAuth | null> {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (!token) return null;
  const rows = await db
    .select()
    .from(schema.mcpTokens)
    .where(and(eq(schema.mcpTokens.tokenHash, sha256(token)), isNull(schema.mcpTokens.revokedAt)));
  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt && row.expiresAt < new Date()) return null;

  const admin = await findAdminByEmail(row.email);
  if (!admin) return null;

  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    void db.update(schema.mcpTokens).set({ lastUsedAt: new Date() }).where(eq(schema.mcpTokens.id, row.id)).execute();
  }
  const scopeName =
    row.scope === "all"
      ? "All committees"
      : ((await db.select().from(schema.committees).where(eq(schema.committees.id, row.scope)))[0]?.name ?? row.scope);
  return { email: row.email, scope: row.scope, scopeName };
}

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

async function scopedEvents(auth: McpAuth) {
  const rows = await db
    .select({ event: schema.events, committee: schema.committees })
    .from(schema.events)
    .innerJoin(schema.committees, eq(schema.events.committeeId, schema.committees.id))
    .orderBy(desc(schema.events.startAt));
  return rows.filter((r) => auth.scope === "all" || r.event.committeeId === auth.scope);
}

async function findScopedEvent(auth: McpAuth, ref: string) {
  const rows = await scopedEvents(auth);
  const needle = ref.trim().toLowerCase();
  return (
    rows.find((r) => r.event.id === ref || r.event.shortCode.toLowerCase() === needle) ??
    rows.find((r) => r.event.title.toLowerCase().includes(needle)) ??
    null
  );
}

function buildMcpServer(session: { auth: McpAuth | null }) {
  const server = new McpServer(
    { name: "scottylabs-invites", version: "1.1.0" },
    {
      instructions:
        "Guest-data access for ScottyLabs Invites organizers. Authorization is OAuth: your MCP client opens invite.scottylabs.org in the browser, you sign in (CMU email code) and approve once, and the client keeps the token — revocable any time from Admin → MCP data access.",
    },
  );

  const requireAuth = (): McpAuth => {
    if (!session.auth) {
      throw new Error("Not authorized — reconnect and approve access in the browser when prompted.");
    }
    return session.auth;
  };

  server.tool("whoami", "Show the signed-in organizer and committee scope for this connection.", {}, async () => {
    if (!session.auth) return text("Not authorized — reconnect and approve access in the browser.");
    return text(`${session.auth.email} · scope: ${session.auth.scopeName}`);
  });

  server.tool("list_events", "List events visible to your committee scope, with signup counts.", {}, async () => {
    const auth = requireAuth();
    const rows = await scopedEvents(auth);
    if (rows.length === 0) return text("No events in your scope yet.");
    const ids = rows.map((r) => r.event.id);
    const counts = await db
      .select({ eventId: schema.registrations.eventId, status: schema.registrations.status, count: sql<number>`count(*)::int` })
      .from(schema.registrations)
      .where(inArray(schema.registrations.eventId, ids))
      .groupBy(schema.registrations.eventId, schema.registrations.status);
    const byEvent = new Map<string, Record<string, number>>();
    for (const c of counts) {
      const m = byEvent.get(c.eventId) ?? {};
      m[c.status] = c.count;
      byEvent.set(c.eventId, m);
    }
    const lines = rows.map(({ event: e, committee: c }) => {
      const m = byEvent.get(e.id) ?? {};
      return `• ${e.title} [${e.shortCode}] — ${c.name} · ${fmtLongDate(e.startAt)} · ${fmtTimeRange(e.startAt, e.endAt)} · ${e.location}\n  model=${e.model}${e.capacity ? ` capacity=${e.capacity}` : ""} approved=${m.approved ?? 0} pending=${m.pending ?? 0} waitlisted=${m.waitlisted ?? 0} status=${e.status}`;
    });
    return text(lines.join("\n"));
  });

  server.tool(
    "guest_list",
    "Full guest list for one event (name, andrew ID, status, major, dietary, source, serial).",
    { event: z.string().describe("Event short code, id, or a title fragment") },
    async ({ event }) => {
      const auth = requireAuth();
      const found = await findScopedEvent(auth, event);
      if (!found) return text(`No event matching “${event}” in your scope. Try list_events.`);
      const regs = await db
        .select({ registration: schema.registrations, user: schema.users })
        .from(schema.registrations)
        .innerJoin(schema.users, eq(schema.registrations.userId, schema.users.id))
        .where(eq(schema.registrations.eventId, found.event.id))
        .orderBy(asc(schema.registrations.createdAt));
      if (regs.length === 0) return text(`${found.event.title}: no signups yet.`);
      const regIds = regs.map((r) => r.registration.id);
      const tickets = await db.select().from(schema.tickets).where(inArray(schema.tickets.registrationId, regIds));
      const ticketByReg = new Map(tickets.filter((t) => !t.revokedAt).map((t) => [t.registrationId, t]));
      const lines = regs.map(({ registration: r, user: u }) => {
        const t = ticketByReg.get(r.id);
        return `• ${r.fullName} (${u.andrewId ?? u.email}) — ${r.status}${t ? ` · ${t.serial}` : ""}${r.major ? ` · ${r.major}` : ""}${r.classYear ? ` '${r.classYear.slice(-2)}` : ""}${(r.dietary as string[])?.length ? ` · diet: ${(r.dietary as string[]).join(", ")}` : ""}${r.source ? ` · via ${r.source}` : ""}${r.plusOne ? " · +1" : ""}`;
      });
      return text(`${found.event.title} — ${regs.length} signups\n${lines.join("\n")}`);
    },
  );

  server.tool("pending_reviews", "Signups waiting for approval across your scope, oldest first.", {}, async () => {
    const auth = requireAuth();
    const events = await scopedEvents(auth);
    const ids = events.map((e) => e.event.id);
    if (ids.length === 0) return text("No events in your scope yet.");
    const pending = await db
      .select({ registration: schema.registrations, user: schema.users })
      .from(schema.registrations)
      .innerJoin(schema.users, eq(schema.registrations.userId, schema.users.id))
      .where(and(inArray(schema.registrations.eventId, ids), eq(schema.registrations.status, "pending")))
      .orderBy(asc(schema.registrations.createdAt));
    if (pending.length === 0) return text("All caught up — no pending reviews.");
    const titleById = new Map(events.map((e) => [e.event.id, e.event.title]));
    const lines = pending.map(({ registration: r, user: u }) => {
      const hours = Math.round((Date.now() - r.createdAt.getTime()) / 3_600_000);
      return `• ${r.fullName} (${u.andrewId ?? u.email}) — ${titleById.get(r.eventId)} · waiting ${hours}h`;
    });
    return text(`${pending.length} pending review${pending.length === 1 ? "" : "s"}\n${lines.join("\n")}`);
  });

  server.tool(
    "export_csv",
    "Export one event's guest list as CSV text (same columns as the dashboard export).",
    { event: z.string().describe("Event short code, id, or a title fragment") },
    async ({ event }) => {
      const auth = requireAuth();
      const found = await findScopedEvent(auth, event);
      if (!found) return text(`No event matching “${event}” in your scope. Try list_events.`);
      const regs = await db
        .select({ registration: schema.registrations, user: schema.users })
        .from(schema.registrations)
        .innerJoin(schema.users, eq(schema.registrations.userId, schema.users.id))
        .where(eq(schema.registrations.eventId, found.event.id))
        .orderBy(asc(schema.registrations.createdAt));
      const regIds = regs.map((r) => r.registration.id);
      const tickets = regIds.length ? await db.select().from(schema.tickets).where(inArray(schema.tickets.registrationId, regIds)) : [];
      const ticketByReg = new Map(tickets.filter((t) => !t.revokedAt).map((t) => [t.registrationId, t]));
      const csv = toCsv(
        ["Name", "Andrew ID", "Email", "Status", "Serial", "Major", "Class year", "Dietary", "Source", "Plus one", "Registered at"],
        regs.map(({ registration: r, user: u }) => [
          r.fullName,
          u.andrewId ?? "",
          u.email,
          r.status,
          ticketByReg.get(r.id)?.serial ?? "",
          r.major ?? "",
          r.classYear ?? "",
          ((r.dietary as string[]) ?? []).join("; "),
          r.source ?? "",
          r.plusOne ? "yes" : "no",
          r.createdAt.toISOString(),
        ]),
      );
      return text(csv);
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP plumbing — streamable transport + OAuth resource-server behavior
// ---------------------------------------------------------------------------

const transports = new Map<string, StreamableHTTPServerTransport>();
const sessions = new Map<string, { auth: McpAuth | null }>();

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      chunks.push(c);
      if (chunks.reduce((n, b) => n + b.length, 0) > 4 * 1024 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolvePromise(undefined);
      try {
        resolvePromise(JSON.parse(raw));
      } catch {
        resolvePromise(undefined);
      }
    });
    req.on("error", reject);
  });
}

export async function startMcpServer(port: number): Promise<void> {
  const mcpOrigin = new URL(env.mcpUrl).origin;
  const resourceMetadata = {
    resource: env.mcpUrl,
    authorization_servers: [env.appUrl],
    bearer_methods_supported: ["header"],
    resource_name: "ScottyLabs Invites guest data",
  };

  const sendJson = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-session-id, mcp-protocol-version, last-event-id",
      "Access-Control-Expose-Headers": "mcp-session-id, WWW-Authenticate",
      ...headers,
    });
    res.end(JSON.stringify(body));
  };

  const challenge = (res: ServerResponse) =>
    sendJson(
      res,
      401,
      { error: "unauthorized", error_description: "Authorize this client to access ScottyLabs Invites guest data." },
      { "WWW-Authenticate": `Bearer resource_metadata="${mcpOrigin}/.well-known/oauth-protected-resource"` },
    );

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (req.method === "OPTIONS") {
      sendJson(res, 204, {});
      return;
    }

    // OAuth discovery (RFC 9728 on this host; AS metadata mirrored for older clients).
    if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      sendJson(res, 200, resourceMetadata);
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/openid-configuration") {
      sendJson(res, 200, authServerMetadata());
      return;
    }

    if (url.pathname === "/health" || (url.pathname === "/" && req.method === "GET")) {
      sendJson(res, 200, { ok: true, service: "scottylabs-invites-mcp", connect: env.mcpUrl, auth: "oauth" });
      return;
    }

    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    try {
      // Every /mcp request must carry a valid bearer token; the 401 challenge
      // is what makes clients kick off the browser authorization flow.
      const auth = await authFromBearer(req.headers.authorization);
      if (!auth) {
        challenge(res);
        return;
      }

      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (req.method === "POST") {
        const body = await readBody(req);
        let transport = sessionId ? transports.get(sessionId) : undefined;

        if (!transport) {
          const sessionState: { auth: McpAuth | null } = { auth };
          const server = buildMcpServer(sessionState);
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id: string) => {
              transports.set(id, transport!);
              sessions.set(id, sessionState);
            },
          });
          transport.onclose = () => {
            if (transport?.sessionId) {
              transports.delete(transport.sessionId);
              sessions.delete(transport.sessionId);
            }
          };
          await server.connect(transport);
        } else if (sessionId) {
          const state = sessions.get(sessionId);
          if (state) state.auth = auth; // freshest token wins (rotation, re-auth)
        }

        await transport.handleRequest(req, res, body);
        return;
      }

      if ((req.method === "GET" || req.method === "DELETE") && sessionId) {
        const transport = transports.get(sessionId);
        if (!transport) {
          res.writeHead(404).end();
          return;
        }
        await transport.handleRequest(req, res);
        return;
      }

      sendJson(res, 405, { error: "method_not_allowed" });
    } catch (err) {
      console.error("[mcp] request error:", err);
      if (!res.headersSent) sendJson(res, 500, { error: "internal" });
    }
  });

  await new Promise<void>((resolvePromise) => httpServer.listen(port, "0.0.0.0", resolvePromise));
  console.log(`[mcp] ScottyLabs Invites MCP listening on :${port} (endpoint /mcp, auth: OAuth via ${env.appUrl})`);
}
