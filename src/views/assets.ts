import manifest from '../generated/assets.json';

type AssetName = 'app.css' | 'common.js' | 'create.js' | 'paste.js';

/** URL of a content-hashed bundle produced by `pnpm run build:client`. */
export function asset(name: AssetName): string {
  const url = (manifest as Record<string, string | undefined>)[name];
  if (!url) throw new Error(`Missing asset "${name}": run "pnpm run build:client"`);
  return url;
}
