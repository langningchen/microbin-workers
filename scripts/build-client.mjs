// Bundles the browser code (src/client + src/shared) and the stylesheet with esbuild.
//
// Output files are content-hashed, so they can be cached "immutable" (see public/_headers).
// A manifest (logical name -> hashed URL) is written to src/generated/assets.json; the Worker
// reads it to emit correct <script>/<link> tags.
import { build } from 'esbuild';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outdir = path.join(root, 'public', 'static');

await rm(outdir, { recursive: true, force: true });

const entryPoints = {
  app: 'src/client/app.css',
  common: 'src/client/common.ts',
  create: 'src/client/create.ts',
  paste: 'src/client/paste.ts',
};

const result = await build({
  absWorkingDir: root,
  entryPoints,
  outdir,
  bundle: true,
  format: 'esm',
  splitting: true, // highlight.js and client-zip are lazy chunks shared by entries
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  entryNames: '[name]-[hash]',
  chunkNames: 'chunk-[hash]',
  assetNames: 'asset-[hash]',
  metafile: true,
  logLevel: 'warning',
});

/** @type {Record<string, string>} */
const manifest = {};
const entrySources = new Set(Object.values(entryPoints));
for (const [file, meta] of Object.entries(result.metafile.outputs)) {
  // dynamic imports (highlight.js, client-zip) also show up as "entry points": skip those
  if (!meta.entryPoint || !entrySources.has(meta.entryPoint)) continue;
  const logical = path.basename(meta.entryPoint).replace(/\.ts$/, '.js');
  manifest[logical] =
    '/' + path.relative(path.join(root, 'public'), path.join(root, file)).split(path.sep).join('/');
}

// `wrangler dev` watches src/ and re-runs this build on every change, so only touch the manifest
// when it really changed (rewriting it unconditionally would retrigger the watcher forever).
const manifestPath = path.join(root, 'src', 'generated', 'assets.json');
const manifestJson = JSON.stringify(manifest, null, 2) + '\n';
const previous = await readFile(manifestPath, 'utf8').catch(() => '');
if (previous !== manifestJson) {
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, manifestJson);
}
console.log('[build:client]', manifest);
