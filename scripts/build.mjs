// Build library ESM + declarations with tsc, then overwrite the Node CLI
// entry with a bundled executable. The Worker target can still be built by
// wrangler directly from src/worker.ts, but dist/worker.js is also emitted for
// package consumers via tsc.
import { build } from 'esbuild';
import { mkdir, readdir, rename, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveTscBin } from './resolve-tsc.mjs';

// Single source of truth for the CLI version: read it here, inline it into the
// bundle via esbuild `define`. Reading npm_package_version at CLI *runtime* is
// unreliable (unset for global bins / npx, or the consumer's version), so the
// value is fixed at build time instead.
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

const OUT = 'dist';
const STAGE = '.dist-staging';

/**
 * Sync compiled output from `srcDir` into `dstDir` without deleting `dstDir` in place.
 * Each file is moved via `rename()`, which atomically replaces its directory entry on
 * the same filesystem so running wrappers/CLI invocations never observe a missing
 * `dist/node.js` mid-build.
 */
async function syncDirAtomic(srcDir, dstDir, deferredTopLevel = new Set()) {
  await mkdir(dstDir, { recursive: true });
  const srcEntries = await readdir(srcDir, { withFileTypes: true });
  const expected = new Set(srcEntries.map((entry) => entry.name));

  for (const entry of srcEntries) {
    if (deferredTopLevel.has(entry.name)) continue;
    const srcPath = join(srcDir, entry.name);
    const dstPath = join(dstDir, entry.name);
    if (entry.isDirectory()) {
      const dstExisting = await readdir(dstDir, { withFileTypes: true });
      const prev = dstExisting.find((item) => item.name === entry.name);
      if (prev && !prev.isDirectory()) {
        await rm(dstPath, { recursive: true, force: true });
      }
      await syncDirAtomic(srcPath, dstPath);
    } else {
      await rename(srcPath, dstPath);
    }
  }

  const dstEntries = await readdir(dstDir, { withFileTypes: true });
  for (const entry of dstEntries) {
    if (deferredTopLevel.has(entry.name)) continue;
    if (!expected.has(entry.name)) {
      await rm(join(dstDir, entry.name), { recursive: true, force: true });
    }
  }
}

await rm(STAGE, { recursive: true, force: true });
await mkdir(STAGE, { recursive: true });

try {
  // Run tsc's JS entry directly with the current Node binary rather than via
  // `pnpm exec`. On Windows the pnpm launcher is `pnpm.cmd`, which spawnSync
  // refuses to run without shell:true (EINVAL since the CVE-2024-27980 fix), and
  // with shell:true trips the DEP0190 arg-escaping warning. Resolving the tsc bin
  // and invoking `node <tsc>` sidesteps both — same pattern as the smoke check
  // below, and drops the build's dependency on pnpm being the caller.
  const tscBin = resolveTscBin();
  const tsc = spawnSync(process.execPath, [tscBin, '-p', 'tsconfig.json', '--outDir', STAGE], {
    stdio: 'inherit',
  });
  if (tsc.error) {
    console.error(`✗ failed to run tsc: ${tsc.error.message}`);
    process.exit(1);
  }
  if (tsc.status !== 0) process.exit(tsc.status ?? 1);
  console.log('✓ emitted staged library modules + declarations');

  await build({
    entryPoints: ['src/node.ts'],
    outfile: `${STAGE}/node.js`,
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    sourcemap: true,
    // Inline the package version so `fiche --version` is correct for global/npx
    // installs (see the note where `pkg` is read). esbuild replaces both
    // identifiers with the string literal at every reference.
    define: {
      __FICHE_VERSION__: JSON.stringify(pkg.version),
      __INKLING_VERSION__: JSON.stringify(pkg.version),
    },
    // Atlas is inlined as a base64 string in src/core/atlas.ts, so no external assets.
    banner: { js: '#!/usr/bin/env node' },
  });

  console.log('✓ built staged node.js');

  // Smoke check: run against the staged artifact BEFORE touching live `dist/`
  // so a broken build never replaces a working runtime binary.
  const smoke = spawnSync(process.execPath, [`${STAGE}/node.js`, '--version'], { encoding: 'utf8' });
  const printedVersion = (smoke.stdout ?? '').trim();
  if (smoke.status !== 0 || printedVersion !== pkg.version) {
    console.error(
      `✗ version smoke check failed: 'node ${STAGE}/node.js --version' printed ` +
        `${JSON.stringify(printedVersion)} (exit ${smoke.status}), expected ${JSON.stringify(pkg.version)}`,
    );
    process.exit(1);
  }
  console.log(`✓ staged version smoke check: --version prints ${pkg.version}`);

  const bundleFiles = new Set(['node.js', 'node.js.map']);
  await syncDirAtomic(STAGE, OUT, bundleFiles);
  await rename(`${STAGE}/node.js.map`, `${OUT}/node.js.map`);
  await rename(`${STAGE}/node.js`, `${OUT}/node.js`);
  console.log(`✓ swapped ${OUT}/ atomically`);
} finally {
  await rm(STAGE, { recursive: true, force: true });
}
