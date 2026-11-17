// Git and npx installs need dist/node.js. The Docker runtime image installs
// production dependencies only and does not copy src/, so this is a no-op there.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

if (!existsSync('src/node.ts') || !existsSync('scripts/build.mjs')) {
  process.exit(0);
}

const result = spawnSync(process.execPath, ['scripts/build.mjs'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
