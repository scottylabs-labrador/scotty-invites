import { env } from "./env";
import { runMigrations } from "./db/migrate";

async function main() {
  await runMigrations();

  if (env.appMode === "mcp") {
    const { startMcpServer } = await import("./mcp/main");
    await startMcpServer(env.port);
    return;
  }

  const { buildServer } = await import("./server");
  const { startScheduler } = await import("./jobs/scheduler");
  const app = await buildServer();
  await app.listen({ port: env.port, host: "0.0.0.0" });
  startScheduler();
  console.log(`[api] ScottyLabs Invites API on :${env.port} (${env.nodeEnv})`);
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
