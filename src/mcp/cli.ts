import { runStdioServer, startHttpServer, SERVER_NAME, SERVER_VERSION } from './server.js';

export async function runMcpCommand(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write(
      `${SERVER_NAME} ${SERVER_VERSION} MCP\n` +
      '  pxpipe-fork mcp              stdio (Claude, Codex, Pi, Ribhu, Cursor, Grok)\n' +
      '  pxpipe-fork mcp --http 47823 Streamable HTTP on 127.0.0.1\n',
    );
    return;
  }
  const httpFlag = argv.indexOf('--http');
  if (httpFlag >= 0) {
    const port = Number(argv[httpFlag + 1] ?? 47823);
    if (!Number.isFinite(port) || port <= 0) {
      process.stderr.write('[pxpipe-fork] mcp --http needs a port\n');
      process.exit(1);
    }
    const server = await startHttpServer(port);
    process.stderr.write(`[pxpipe-fork] MCP streamable HTTP on http://127.0.0.1:${server.port}/mcp\n`);
    await new Promise<void>(() => {});
    return;
  }
  await runStdioServer();
}
