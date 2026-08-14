import { defineConfig } from "vitest/config";

// Several tests mutate the single shared app_settings row for the whole
// process (see setControlsReturningPrevious in src/test/harness.ts) and
// restore it in a `finally`. That's only safe if test files run one at a
// time, not in parallel worker processes.
export default defineConfig({
  test: {
    fileParallelism: false,
    // Fastify logs two JSON lines per request at "info", and the global error
    // handler logs a full stack for every deliberately-provoked 4xx — of which
    // this suite has many. Silenced here, not by changing the default in
    // src/env.ts, so production logging is untouched.
    env: { LOG_LEVEL: "silent" },
  },
});
