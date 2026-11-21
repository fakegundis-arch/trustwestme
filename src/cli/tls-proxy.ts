import * as https from 'node:https';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { logger } from '../util/log';

const log = logger('tls-proxy');

/**
 * HTTPS front end for the gateway, so a client with a hardcoded
 * `https://api.westwallet.io/...` URL can be pointed here instead.
 *
 * Only needed when nothing else already owns port 443. If nginx is running,
 * add a server block there instead — see docs/REDIRECT-WESTWALLET.md, which the
 * setup script picks for you.
 *
 *   TLS_CERT=/etc/gateway-tls/server.crt \
 *   TLS_KEY=/etc/gateway-tls/server.key \
 *   TLS_TARGET_PORT=8787 \
 *   npm run tls-proxy
 */

const certPath = process.env.TLS_CERT || '/etc/gateway-tls/server.crt';
const keyPath = process.env.TLS_KEY || '/etc/gateway-tls/server.key';
const listenPort = Number(process.env.TLS_PROXY_PORT || 443);
const listenHost = process.env.TLS_PROXY_HOST || '127.0.0.1';
const targetPort = Number(process.env.TLS_TARGET_PORT || 8787);
const targetHost = process.env.TLS_TARGET_HOST || '127.0.0.1';

function main() {
  // Distinguish "absent" from "there but unreadable". Both used to print
  // "not found", which sent diagnosis down the wrong path entirely: the usual
  // cause is this process running as a service account that cannot traverse
  // /etc/gateway-tls (root-only directory mode), with the files present and
  // correctly owned the whole time. The remedy is the opposite of re-running
  // setup, so the message has to say which case it is.
  for (const [label, file] of [['certificate', certPath], ['private key', keyPath]] as const) {
    try {
      fs.accessSync(file, fs.constants.R_OK);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        log.error(`${label} not found at ${file}. Run scripts/setup-westwallet-redirect.sh first.`);
      } else if (code === 'EACCES') {
        log.error(
          `${label} at ${file} exists but this process cannot read it `
          + `(running as uid ${process.getuid?.() ?? '?'}). `
          + 'Check the directory is traversable, not just the file readable: '
          + `ls -ld ${path.dirname(file)}`,
        );
      } else {
        log.error(`${label} at ${file} is unreadable: ${(e as Error).message}`);
      }
      process.exit(1);
    }
  }

  const server = https.createServer(
    { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) },
    (req, res) => {
      const proxied = http.request(
        {
          host: targetHost,
          port: targetPort,
          path: req.url,
          method: req.method,
          headers: { ...req.headers, host: `${targetHost}:${targetPort}` },
        },
        (upstream) => {
          res.writeHead(upstream.statusCode ?? 502, upstream.headers);
          upstream.pipe(res);
        },
      );
      proxied.on('error', (e) => {
        log.error(`upstream request failed: ${e.message}`);
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'bad_gateway', message: 'the gateway is not reachable' }));
      });
      // The body must be streamed through untouched: the signature covers the
      // exact bytes, so any re-encoding here would invalidate it.
      req.pipe(proxied);
    },
  );

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log.error(`port ${listenPort} is already in use — nginx or another server owns it. `
        + 'Add a server block there instead of running this proxy; '
        + 'see docs/REDIRECT-WESTWALLET.md.');
    } else if (err.code === 'EACCES') {
      log.error(`not allowed to bind port ${listenPort}. Ports below 1024 need root.`);
    } else {
      log.error('TLS proxy failed to start', err.message);
    }
    process.exit(1);
  });

  server.listen(listenPort, listenHost, () => {
    log.info(`TLS proxy on https://${listenHost}:${listenPort} -> http://${targetHost}:${targetPort}`);
  });
}

main();
