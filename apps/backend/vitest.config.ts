import { defineConfig } from "vitest/config";

// Several tests mutate the single shared app_settings row for the whole
// process (see setControlsReturningPrevious in src/test/harness.ts) and
// restore it in a `finally`. That's only safe if test files run one at a
// time, not in parallel worker processes.
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
