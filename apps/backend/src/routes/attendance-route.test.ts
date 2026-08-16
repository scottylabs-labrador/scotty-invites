import { afterAll, beforeAll, describe, expect, it } from "vitest";

const TEST_ENV = {
  DATABASE_URL: "postgres://postgres:postgres@localhost:5433/scottylabs_invites",
  TRANSFER_LINK_SECRET: "test-secret-not-used-here-0123456789abcdef",
  SEED_SUPER_ADMIN_EMAILS: "",
  MAIL_MODE: "console",
};
for (const [k, v] of Object.entries(TEST_ENV)) if (process.env[k] === undefined) process.env[k] = v;

import type { FastifyInstance } from "fastify";
import { buildServer } from "../server";

describe("GET /api/org/attendance.csv", () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await buildServer(); });
  afterAll(async () => { await app.close(); });

  it("rejects unauthenticated requests", async () => {
    const res = await app.inject({ method: "GET", url: "/api/org/attendance.csv?shape=long" });
    expect(res.statusCode).toBe(401);
  });

  it("is registered (does not 404)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/org/attendance.csv" });
    expect(res.statusCode).not.toBe(404);
  });
});
