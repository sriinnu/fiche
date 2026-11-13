#!/usr/bin/env node
// stdio MCP without the caller having to pass the `mcp` subcommand.
process.argv.splice(2, 0, 'mcp');
import('../dist/node.js').catch((err) => {
  console.error('[inkling-mcp] failed to start:', err);
  console.error('[inkling-mcp] did you forget to `pnpm build`?');
  process.exit(1);
});
