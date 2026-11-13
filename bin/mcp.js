#!/usr/bin/env node
// stdio MCP without the caller having to pass the `mcp` subcommand.
process.argv.splice(2, 0, 'mcp');
import('../dist/node.js').catch((err) => {
  console.error('[inkling] failed to start MCP:', err);
  console.error('[inkling] did you forget to `pnpm build`?');
  process.exit(1);
});
