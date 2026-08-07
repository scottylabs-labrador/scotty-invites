import { migrate } from "drizzle-orm/node-postgres/migrator";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { db, pool } from "./client";
import { seed } from "./seed";

export async function runMigrations(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = resolve(here, "../../drizzle");
  await migrate(db, { migrationsFolder });
  await seed();
  console.log("[db] migrations + seed complete");
}

// Standalone: pnpm db:migrate
if (process.argv[1] && process.argv[1].endsWith("migrate.ts")) {
  runMigrations()
    .then(() => pool.end())
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
