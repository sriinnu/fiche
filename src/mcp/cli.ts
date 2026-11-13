import { runStdioServer, startHttpServer, SERVER_NAME, SERVER_VERSION } from './server.js';

export async function runMcpCommand(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write(
      `${SERVER_NAME} ${SERVER_VERSION}\n` +
      '  inkling-mcp                 stdio\n' +
      '  inkling-mcp --http 47823    Streamable HTTP on 127.0.0.1\n',
    );
    return;
  }
  const httpFlag = argv.indexOf('--http');
  if (httpFlag >= 0) {
    const port = Number(argv[httpFlag + 1] ?? 47823);
    if (!Number.isFinite(port) || port <= 0) {
      process.stderr.write('[inkling-mcp] --http needs a port\n');
      process.exit(1);
    }
    const server = await startHttpServer(port);
    process.stderr.write(`[inkling-mcp] streamable HTTP on http://127.0.0.1:${server.port}/mcp\n`);
    await new Promise<void>(() => {});
    return;
  }
  await runStdioServer();
}
