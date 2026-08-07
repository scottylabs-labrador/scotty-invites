import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { env } from "../env";
import * as schema from "./schema";

export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: 10,
  ssl: env.databaseSsl ? { rejectUnauthorized: false } : undefined,
});

export const db = drizzle(pool, { schema });
export type Db = typeof db;
export { schema };
