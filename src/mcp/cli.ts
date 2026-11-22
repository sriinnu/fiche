import { runStdioServer, startHttpServer, SERVER_NAME, SERVER_VERSION } from './server.js';

function parseHttpPort(argv: readonly string[]): { enabled: boolean; port: number } {
  const eqArg = argv.find((a) => a.startsWith('--http='));
  if (eqArg !== undefined) {
    const raw = eqArg.slice('--http='.length).trim();
    const port = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      process.stderr.write('[fiche-mcp] --http needs an integer port in 1..65535\n');
      process.exit(1);
    }
    return { enabled: true, port };
  }
  const idx = argv.indexOf('--http');
  if (idx >= 0) {
    const next = argv[idx + 1];
    const raw = next !== undefined && !next.startsWith('-') ? next.trim() : '47823';
    const port = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      process.stderr.write('[fiche-mcp] --http needs an integer port in 1..65535\n');
      process.exit(1);
    }
    return { enabled: true, port };
  }
  return { enabled: false, port: 47823 };
}

export async function runMcpCommand(argv: string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stderr.write(
      `${SERVER_NAME} ${SERVER_VERSION}\n` +
      '  fiche-mcp                      stdio (also: fiche mcp)\n' +
      '  fiche-mcp --http [47823]       Streamable HTTP on 127.0.0.1 + ::1\n' +
      '  fiche-mcp --http=47823 --ipv4  Streamable HTTP on 127.0.0.1 only\n',
    );
    return;
  }
  const httpOpt = parseHttpPort(argv);
  if (httpOpt.enabled) {
    const ipv4Only = argv.includes('--ipv4');
    const server = await startHttpServer(httpOpt.port, { ipv4Only });
    const hostsLabel = server.ipv6Listening ? '127.0.0.1 + ::1' : '127.0.0.1';
    process.stderr.write(`[fiche-mcp] streamable HTTP on http://127.0.0.1:${server.port}/mcp (${hostsLabel})\n`);
    await new Promise<void>((resolve) => {
      let closing = false;
      const stop = () => {
        if (closing) return;
        closing = true;
        void server.close().finally(resolve);
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    return;
  }
  await runStdioServer();
}
