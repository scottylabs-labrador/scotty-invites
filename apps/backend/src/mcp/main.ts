import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db, schema } from "../db/client";
import { env } from "../env";
import { newToken, sha256 } from "../lib/crypto";
import { startAuth, consumeCode, findAdminByEmail } from "../auth/service";
import { toCsv } from "../lib/csv";
import { fmtLongDate, fmtTimeRange } from "../lib/format";

interface McpAuth {
  email: string;
  scope: string; // "all" or committee id
  scopeName: string;
}

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
  void db.update(schema.mcpTokens).set({ lastUsedAt: new Date() }).where(eq(schema.mcpTokens.id, row.id)).execute();
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

function buildMcpServer(session: { auth: McpAuth | null; clientName: string | null }) {
  const server = new McpServer(
    { name: "scottylabs-invites", version: "1.0.0" },
    {
      instructions:
        "Guest-data access for ScottyLabs Invites organizers. If you have a token, connect with Authorization: Bearer <token>. Otherwise call start_sign_in with your admin email, read the 6-digit code from your inbox (sent via Mailgun), then verify_code — that mints a committee-scoped token and unlocks the data tools.",
    },
  );

  const requireAuth = (): McpAuth => {
    if (!session.auth) {
      throw new Error("Not signed in. Call start_sign_in with your admin email, then verify_code with the 6-digit code we emailed you.");
    }
    return session.auth;
  };

  server.tool(
    "start_sign_in",
    "Begin email verification for MCP access. Sends a 6-digit code (via Mailgun) to an organizer email that has admin rights.",
    { email: z.string().email().describe("Your organizer email") },
    async ({ email }) => {
      const admin = await findAdminByEmail(email.toLowerCase());
      if (!admin) return text(`${email} isn't an organizer on ScottyLabs Invites. Ask a super admin for an invite first.`);
      const result = await startAuth({ email, keepSignedIn: false, ip: "mcp" });
      if (!result.ok) return text(result.message);
      return text(`Code sent to ${email} — check your inbox, then call verify_code with the 6 digits.`);
    },
  );

  server.tool(
    "verify_code",
    "Finish email verification: mints a committee-scoped MCP token and signs this session in. Save the token for future connections (Authorization: Bearer <token>).",
    { email: z.string().email(), code: z.string().regex(/^\d{6}$/) },
    async ({ email, code }) => {
      const result = await consumeCode(email, code);
      if ("error" in result) return text(result.message);
      const admin = await findAdminByEmail(email.toLowerCase());
      if (!admin) return text("That email verified, but it isn't an organizer. Ask a super admin for an invite.");
      const scope = admin.admin.role === "super_admin" ? "all" : admin.admin.committeeId;
      const raw = newToken();
      await db.insert(schema.mcpTokens).values({
        tokenHash: sha256(raw),
        email: email.toLowerCase(),
        scope,
        label: session.clientName,
      });
      session.auth = {
        email: email.toLowerCase(),
        scope,
        scopeName: admin.admin.role === "super_admin" ? "All committees" : admin.committee.name,
      };
      return text(
        `Signed in as ${email} (scope: ${session.auth.scopeName}).\n\nYour MCP token (save it — shown once):\n${raw}\n\nReconnect any time with header  Authorization: Bearer ${raw}`,
      );
    },
  );

  server.tool("whoami", "Show the signed-in organizer and committee scope for this session.", {}, async () => {
    if (!session.auth) return text("Not signed in — call start_sign_in first (or reconnect with a Bearer token).");
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
// HTTP plumbing (streamable transport, session per client)
// ---------------------------------------------------------------------------

const transports = new Map<string, StreamableHTTPServerTransport>();
const sessions = new Map<string, { auth: McpAuth | null; clientName: string | null }>();

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
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (url.pathname === "/health" || (url.pathname === "/" && req.method === "GET")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "scottylabs-invites-mcp", connect: `${env.mcpUrl}` }));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (req.method === "POST") {
        const body = await readBody(req);
        let transport = sessionId ? transports.get(sessionId) : undefined;

        if (!transport) {
          const sessionState: { auth: McpAuth | null; clientName: string | null } = {
            auth: await authFromBearer(req.headers.authorization),
            clientName: null,
          };
          const server = buildMcpServer(sessionState);
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id: string) => {
              transports.set(id, transport!);
              sessions.set(id, sessionState);
              const client = server.server.getClientVersion();
              if (client?.name) sessionState.clientName = client.name;
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
          // Refresh bearer auth on reconnects that carry a token.
          const state = sessions.get(sessionId);
          if (state && !state.auth) {
            state.auth = await authFromBearer(req.headers.authorization);
          }
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

      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "method_not_allowed" }));
    } catch (err) {
      console.error("[mcp] request error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "internal" }));
      }
    }
  });

  await new Promise<void>((resolvePromise) => httpServer.listen(port, "0.0.0.0", resolvePromise));
  console.log(`[mcp] ScottyLabs Invites MCP listening on :${port} (endpoint /mcp)`);
}
