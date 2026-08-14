import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Minimal .env loader (repo root + backend dir), no dependency needed.
function loadDotEnv() {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [resolve(here, "../../../.env"), resolve(here, "../.env")];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let value = m[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = value;
    }
  }
}
loadDotEnv();

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

const port = Number(process.env.PORT ?? 4000);

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  isProd: (process.env.NODE_ENV ?? "development") === "production",
  appMode: (process.env.APP_MODE ?? "api") as "api" | "mcp",
  port,
  /** Fastify/pino log level. Tests set this to "silent" (see vitest.config.ts) so
   *  the two JSON lines per request, and the full stack the error handler logs
   *  for every deliberately-provoked 4xx, don't bury the actual test output. */
  logLevel: process.env.LOG_LEVEL ?? "info",
  databaseUrl: required("DATABASE_URL"),
  databaseSsl: process.env.DATABASE_SSL === "1",
  /** Public origin of the web app (used in emails, transfer links, redirects). */
  appUrl: (process.env.APP_URL ?? `http://localhost:5173`).replace(/\/$/, ""),
  /** Public origin of the API (magic-link callback). Same origin as appUrl in single-service deploys. */
  apiUrl: (process.env.API_URL ?? process.env.APP_URL ?? `http://localhost:${port}`).replace(/\/$/, ""),
  /** Public URL of the MCP server, shown in the admin portal. */
  mcpUrl: (process.env.MCP_PUBLIC_URL ?? "http://localhost:4100/mcp").replace(/\/$/, ""),
  cookieDomain: process.env.COOKIE_DOMAIN || undefined,
  /** Serve the built SPA from this directory (single-service deploy). */
  webDist: process.env.WEB_DIST || undefined,
  corsOrigins: (process.env.CORS_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),

  mailMode: (process.env.MAIL_MODE ?? (process.env.MAILGUN_API_KEY ? "mailgun" : "console")) as
    | "mailgun"
    | "console",
  mailgunApiKey: process.env.MAILGUN_API_KEY ?? "",
  mailgunDomain: process.env.MAILGUN_DOMAIN ?? "mail.scottylabs.org",
  mailgunRegion: (process.env.MAILGUN_REGION ?? "us") as "us" | "eu",
  mailFrom: process.env.MAILGUN_FROM_EMAIL ?? "ScottyLabs Scotty Invite <noreply@mail.scottylabs.org>",

  seedSuperAdminEmails: (process.env.SEED_SUPER_ADMIN_EMAILS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  /** HMAC key for +1 transfer links (nothing secret is stored at rest). */
  transferLinkSecret: process.env.TRANSFER_LINK_SECRET ?? "dev-transfer-secret-change-me",

  // Apple Wallet (optional — pass generation activates only when all are present)
  applePassCert: process.env.APPLE_PASS_CERT_PEM,
  applePassKey: process.env.APPLE_PASS_KEY_PEM,
  appleWwdrCert: process.env.APPLE_WWDR_CERT_PEM,
  applePassTypeId: process.env.APPLE_PASS_TYPE_ID ?? "pass.org.scottylabs.invite",
  appleTeamId: process.env.APPLE_TEAM_ID,

  // Google Wallet (optional)
  googleWalletIssuerId: process.env.GOOGLE_WALLET_ISSUER_ID,
  googleWalletSaEmail: process.env.GOOGLE_WALLET_SA_EMAIL,
  googleWalletSaKey: process.env.GOOGLE_WALLET_SA_KEY_PEM,
};

// Fail closed in production: +1 transfer links (and the Apple pass auth token)
// are HMAC'd with this. Booting prod with the source-visible dev default would
// make every +1 token forgeable, so refuse to start.
const DEV_TRANSFER_SECRET = "dev-transfer-secret-change-me";
if (env.isProd && (env.transferLinkSecret === DEV_TRANSFER_SECRET || env.transferLinkSecret.length < 32)) {
  throw new Error("TRANSFER_LINK_SECRET must be set to a strong value (>= 32 chars) in production");
}

export const ALLOWED_DOMAINS = ["andrew.cmu.edu", "cs.cmu.edu", "cmu.edu"];

export function emailDomain(email: string): string {
  return email.split("@")[1]?.toLowerCase() ?? "";
}

export function isCmuEmail(email: string): boolean {
  return ALLOWED_DOMAINS.includes(emailDomain(email));
}
