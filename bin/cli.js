#!/usr/bin/env node
// Tiny shim: just runs the bundled Node entry. Real CLI logic lives in src/node.ts.
import('../dist/node.js').catch((err) => {
  console.error('[fiche] failed to start:', err);
  console.error('[fiche] did you forget to `npm run build`?');
  process.exit(1);
});
