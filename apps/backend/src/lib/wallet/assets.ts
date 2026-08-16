import { readFileSync } from "node:fs";

/**
 * Pass images, read from disk once and cached.
 *
 * The backend is never compiled or bundled (tsconfig has noEmit, package.json
 * starts `tsx src/index.ts`), so these .png files ship verbatim into the Docker
 * image via `COPY apps ./apps`. Resolve them from import.meta.url — the same
 * pattern env.ts:7-8 uses — never from process.cwd().
 *
 * Never write `import icon from "./assets/icon.png"`: tsx has no asset loader
 * and it throws ERR_UNKNOWN_FILE_EXTENSION at runtime while looking fine in an
 * editor.
 */
const NAMES = ["icon.png", "icon@2x.png", "icon@3x.png", "logo.png", "logo@2x.png", "logo@3x.png"] as const;

let cache: { name: string; data: Buffer }[] | null = null;

export function passAssets(): { name: string; data: Buffer }[] {
  if (!cache) {
    cache = NAMES.map((name) => ({ name, data: readFileSync(new URL(`./assets/${name}`, import.meta.url)) }));
  }
  return cache;
}
