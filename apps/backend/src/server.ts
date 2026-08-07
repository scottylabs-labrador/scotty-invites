import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { initServer } from "@ts-rest/fastify";
import { and, asc, eq, gte, inArray, isNull } from "drizzle-orm";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { db, schema } from "./db/client";
import { env } from "./env";
import { router, contract, setSessionCookie, deriveLocationShort } from "./routes/router";
import { resolveSession, verifyByToken, type AuthContext } from "./auth/service";
import { buildIcs, googleCalendarUrl } from "./lib/ics";
import { toCsv } from "./lib/csv";
import { buildPkpass } from "./lib/wallet/apple";

declare module "fastify" {
  interface FastifyRequest {
    authCtx: AuthContext | null;
  }
}

const SESSION_COOKIE = "sl_invites_session";
const MAX_RESUME_BYTES = 5 * 1024 * 1024;
const RESUME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: env.isProd ? "info" : "info" }, trustProxy: true, bodyLimit: 6 * 1024 * 1024 });

  await app.register(cookie);
  await app.register(formbody);
  await app.register(multipart, { limits: { fileSize: MAX_RESUME_BYTES, files: 1 } });

  if (env.corsOrigins.length > 0) {
    await app.register(cors, { origin: env.corsOrigins, credentials: true });
  }

  app.decorateRequest("authCtx", null);

  // Session resolution + CSRF origin check for API routes.
  app.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/api")) return;

    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin) {
        const allowed = new Set([env.appUrl, env.apiUrl, ...env.corsOrigins]);
        if (!allowed.has(origin)) {
          return reply.status(403).send({ error: "origin", message: "Cross-origin request rejected." });
        }
      }
    }

    request.authCtx = await resolveSession(request.cookies[SESSION_COOKIE]);
  });

  // Security headers everywhere.
  app.addHook("onSend", async (request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
    if (!request.url.startsWith("/api")) {
      reply.header("X-Frame-Options", "DENY");
    }
    if (env.isProd) {
      reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
  });

  // ---------------------------------------------------------------- ts-rest
  const s = initServer();
  await app.register(s.plugin(router));

  // ---------------------------------------------------------------- plain routes

  app.get("/api/health", async () => ({ ok: true, service: "scottylabs-invites-api" }));

  // Magic-link click-through. The GET renders a confirmation page and never
  // touches the database — email security scanners prefetch GET links, and a
  // consuming GET would burn the link (and its paired 6-digit code) before
  // the person ever sees it. Only the explicit POST consumes the token.
  app.get("/api/auth/callback", async (request, reply) => {
    const token = (request.query as { token?: string }).token;
    if (!token) return reply.redirect(`${env.appUrl}/signin?error=missing_token`);
    const safeToken = token.replace(/[^A-Za-z0-9_-]/g, "");
    reply.header("Content-Type", "text/html; charset=utf-8");
    reply.header("Cache-Control", "no-store");
    return reply.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Sign in — ScottyLabs Invites</title></head>
<body style="margin:0;background:#f0f4f8;font-family:Inter,Helvetica,Arial,sans-serif;display:flex;align-items:flex-start;justify-content:center;min-height:100vh">
<div style="margin-top:12vh;width:100%;max-width:400px;background:#fff;border:1px solid #c7d2dc;border-radius:16px;box-shadow:0 2px 8px rgba(30,30,30,0.08);padding:32px 28px;text-align:center;box-sizing:border-box">
<div style="font-size:17px;font-weight:700;letter-spacing:-0.02em;color:#1e1e1e">ScottyLabs Invites</div>
<p style="margin:14px 0 0;font-size:14px;line-height:1.55;color:#5f6f7f">One click to confirm it's really you — then you're signed in on this device.</p>
<form method="POST" action="/api/auth/callback" style="margin:20px 0 0">
<input type="hidden" name="token" value="${safeToken}">
<button type="submit" style="width:100%;border:none;cursor:pointer;background:#0e96d1;color:#fff;font-size:15px;font-weight:600;font-family:inherit;padding:13px 0;border-radius:100px">Continue to ScottyLabs Invites</button>
</form>
<p style="margin:16px 0 0;font-size:11.5px;color:#7a8fa3">Didn't request this email? You can close this page.</p>
</div></body></html>`);
  });

  app.post("/api/auth/callback", async (request, reply) => {
    const token = (request.body as { token?: string } | undefined)?.token;
    if (!token) return reply.redirect(`${env.appUrl}/signin?error=missing_token`);
    const result = await verifyByToken(token);
    if (!result) return reply.redirect(`${env.appUrl}/signin?error=expired`);
    setSessionCookie(reply, result.sessionToken, result.persistent);
    return reply.redirect(`${env.appUrl}/signin?verified=1`);
  });

  // Resume upload (multipart) — signed-in users only.
  app.post("/api/files", async (request, reply) => {
    if (!request.authCtx) return reply.status(401).send({ error: "unauthorized", message: "Sign in first." });
    const file = await request.file();
    if (!file) return reply.status(400).send({ error: "no_file", message: "Attach a file." });
    if (!RESUME_TYPES.has(file.mimetype)) {
      return reply.status(400).send({ error: "type", message: "PDF or Word documents only." });
    }
    const data = await file.toBuffer();
    if (data.length > MAX_RESUME_BYTES) {
      return reply.status(400).send({ error: "size", message: "Keep it under 5 MB." });
    }
    const inserted = await db
      .insert(schema.files)
      .values({
        ownerUserId: request.authCtx.user.id,
        kind: "resume",
        filename: file.filename.slice(0, 200) || "resume.pdf",
        contentType: file.mimetype,
        size: data.length,
        data,
      })
      .returning({ id: schema.files.id, filename: schema.files.filename });
    return reply.send({ id: inserted[0].id, filename: inserted[0].filename, url: `${env.apiUrl}/api/files/${inserted[0].id}` });
  });

  // Resume download — owner or any admin.
  app.get("/api/files/:id", async (request, reply) => {
    const ctx = request.authCtx;
    if (!ctx) return reply.status(401).send({ error: "unauthorized", message: "Sign in first." });
    const { id } = request.params as { id: string };
    if (!/^[0-9a-f-]{36}$/.test(id)) return reply.status(404).send({ error: "not_found", message: "No such file." });
    const rows = await db.select().from(schema.files).where(eq(schema.files.id, id));
    const file = rows[0];
    if (!file) return reply.status(404).send({ error: "not_found", message: "No such file." });
    if (file.ownerUserId !== ctx.user.id && !ctx.admin) {
      return reply.status(403).send({ error: "forbidden", message: "Not yours to read." });
    }
    reply.header("Content-Type", file.contentType);
    reply.header("Content-Disposition", `attachment; filename="${file.filename.replace(/[^\w.\- ]/g, "_")}"`);
    return reply.send(file.data);
  });

  // CSV export — one query surface, committee-scoped.
  app.get("/api/org/events/:id/export.csv", async (request, reply) => {
    const ctx = request.authCtx;
    if (!ctx?.admin) return reply.status(401).send({ error: "unauthorized", message: "Organizers only." });
    const { id } = request.params as { id: string };
    const events = await db.select().from(schema.events).where(eq(schema.events.id, id));
    const event = events[0];
    if (!event) return reply.status(404).send({ error: "not_found", message: "Event not found" });
    if (ctx.admin.row.role !== "super_admin" && ctx.admin.row.committeeId !== event.committeeId) {
      return reply.status(403).send({ error: "forbidden", message: "Not your committee's event." });
    }

    const regs = await db
      .select({ registration: schema.registrations, user: schema.users })
      .from(schema.registrations)
      .innerJoin(schema.users, eq(schema.registrations.userId, schema.users.id))
      .where(eq(schema.registrations.eventId, id))
      .orderBy(asc(schema.registrations.createdAt));

    const regIds = regs.map((r) => r.registration.id);
    const ticketRows = regIds.length
      ? await db.select().from(schema.tickets).where(inArray(schema.tickets.registrationId, regIds))
      : [];
    const ticketByReg = new Map(ticketRows.filter((t) => !t.revokedAt).map((t) => [t.registrationId, t]));

    const checkinRows = regIds.length
      ? await db
          .select()
          .from(schema.checkins)
          .where(and(eq(schema.checkins.eventId, id), eq(schema.checkins.result, "ok")))
      : [];
    const checkinByTicket = new Map(checkinRows.map((c) => [c.ticketId, c]));

    const allQuestions = await db
      .select()
      .from(schema.eventQuestions)
      .where(eq(schema.eventQuestions.eventId, id))
      .orderBy(asc(schema.eventQuestions.sort));
    const questions = allQuestions.filter((q) => q.kind === "custom" || q.key === "phone" || q.key === "tshirt");
    const answerRows = regIds.length
      ? await db.select().from(schema.answers).where(inArray(schema.answers.registrationId, regIds))
      : [];
    const answerByRegAndQ = new Map(answerRows.map((a) => [`${a.registrationId}:${a.questionId}`, a.value]));

    const headers = [
      "Name",
      "Andrew ID",
      "Email",
      "Status",
      "Serial",
      "Number",
      "Major",
      "Class year",
      "Dietary",
      "Resume",
      "Source",
      "Plus one",
      "Checked in at",
      "Registered at",
      ...questions.map((q) => q.label),
    ];
    const rows = regs.map(({ registration: r, user: u }) => {
      const ticket = ticketByReg.get(r.id);
      const checkin = ticket ? checkinByTicket.get(ticket.id) : undefined;
      return [
        r.fullName,
        u.andrewId ?? "",
        u.email,
        r.status,
        ticket?.serial ?? "",
        ticket?.number ?? "",
        r.major ?? "",
        r.classYear ?? "",
        ((r.dietary as string[]) ?? []).join("; "),
        r.resumeFileId ? `${env.apiUrl}/api/files/${r.resumeFileId}` : "",
        r.source ?? "",
        r.plusOne ? "yes" : "no",
        checkin ? checkin.createdAt.toISOString() : "",
        r.createdAt.toISOString(),
        ...questions.map((q) => String(answerByRegAndQ.get(`${r.id}:${q.id}`) ?? "")),
      ];
    });

    reply.header("Content-Type", "text/csv; charset=utf-8");
    reply.header(
      "Content-Disposition",
      `attachment; filename="${event.title.replace(/[^\w.\- ]/g, "_").slice(0, 60)} guests.csv"`,
    );
    return reply.send(toCsv(headers, rows));
  });

  // Apple Wallet pass.
  app.get("/api/tickets/:id/apple.pkpass", async (request, reply) => {
    const ctx = request.authCtx;
    if (!ctx) return reply.status(401).send({ error: "unauthorized", message: "Sign in first." });
    const { id } = request.params as { id: string };
    const result = await buildPkpass(id, ctx.user.id);
    if (!result.ok) return reply.status(result.status).send({ error: "wallet", message: result.message });
    reply.header("Content-Type", "application/vnd.apple.pkpass");
    reply.header("Content-Disposition", `attachment; filename="${result.filename}"`);
    return reply.send(result.buffer);
  });

  // ICS: whole-club subscribe feed + per-event file.
  app.get("/api/calendar.ics", async (_request, reply) => {
    const now = new Date();
    const rows = await db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.status, "published"), eq(schema.events.listed, true), gte(schema.events.endAt, now)))
      .orderBy(asc(schema.events.startAt));
    const ics = buildIcs(
      rows.map((e) => ({
        uid: e.shortCode,
        title: e.title,
        description: e.description,
        location: e.location,
        startAt: e.startAt,
        endAt: e.endAt,
        url: `${env.appUrl}/e/${e.shortCode}`,
      })),
    );
    reply.header("Content-Type", "text/calendar; charset=utf-8");
    return reply.send(ics);
  });

  app.get("/api/events/:code/calendar.ics", async (request, reply) => {
    const { code } = request.params as { code: string };
    const rows = await db.select().from(schema.events).where(eq(schema.events.shortCode, code));
    const e = rows[0];
    if (!e || e.status !== "published") return reply.status(404).send({ error: "not_found", message: "Event not found" });
    const ics = buildIcs(
      [
        {
          uid: e.shortCode,
          title: e.title,
          description: e.description,
          location: e.location,
          startAt: e.startAt,
          endAt: e.endAt,
          url: `${env.appUrl}/e/${e.shortCode}`,
        },
      ],
      e.title,
    );
    reply.header("Content-Type", "text/calendar; charset=utf-8");
    reply.header("Content-Disposition", `attachment; filename="${e.shortCode}.ics"`);
    return reply.send(ics);
  });

  app.get("/api/events/:code/google-calendar", async (request, reply) => {
    const { code } = request.params as { code: string };
    const rows = await db.select().from(schema.events).where(eq(schema.events.shortCode, code));
    const e = rows[0];
    if (!e) return reply.status(404).send({ error: "not_found", message: "Event not found" });
    return reply.redirect(
      googleCalendarUrl({
        uid: e.shortCode,
        title: e.title,
        description: e.description,
        location: e.location,
        startAt: e.startAt,
        endAt: e.endAt,
        url: `${env.appUrl}/e/${e.shortCode}`,
      }),
    );
  });

  // ---------------------------------------------------------------- SPA
  if (env.webDist && existsSync(env.webDist)) {
    const dist = resolve(env.webDist);
    await app.register(fastifyStatic, {
      root: dist,
      wildcard: false,
      setHeaders(res, path) {
        if (path.includes("/assets/")) res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        else res.setHeader("Cache-Control", "no-cache");
      },
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api")) {
        return reply.status(404).send({ error: "not_found", message: "No such endpoint" });
      }
      return reply.sendFile("index.html");
    });
    app.log.info(`[web] serving SPA from ${dist}`);
  }

  return app;
}
