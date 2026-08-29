import express from 'express';
import { config } from '../config';
import { authenticate } from './auth';
import { routes } from './routes';
import { logger } from '../util/log';

const log = logger('http');

export function createServer() {
  const app = express();
  app.disable('x-powered-by');
  // Keep the raw body. A WestWallet signature covers the exact bytes the client
  // sent, so verifying against a re-serialised copy would fail whenever the
  // client's JSON formatting differs from ours by so much as a space.
  app.use(express.json({
    limit: '256kb',
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: string }).rawBody = buf.toString('utf8');
    },
  }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));

  // Every WestWallet response carries an `error` field, and their clients test
  // `if (response.error != "ok")` to decide whether a call succeeded. So a
  // successful reply must say so explicitly — without this, a WestWallet client
  // treats every 200 as a failure.
  app.use((_req, res, next) => {
    const sendJson = res.json.bind(res);
    res.json = (body: unknown) => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(body);
      const payload = body as Record<string, unknown>;
      const succeeded = res.statusCode < 400;
      const extras: Record<string, unknown> = {};

      if (payload.error === undefined) extras.error = succeeded ? 'ok' : 'error';

      // Some callers read a top-level `status` instead. Only ever added when
      // the body has none of its own: a transaction carries `status:
      // "completed"`, and overwriting that with "ok" would tell the caller a
      // settled deposit had not settled. Never added to an error response.
      if (succeeded && payload.status === undefined) extras.status = 'ok';

      // Spread the body last so nothing here can shadow a real field.
      return sendJson({ ...extras, ...payload });
    };
    next();
  });

  // Log every request once it finishes. Anything that failed is logged at warn,
  // so a misconfigured caller shows up in the log without turning on debug —
  // this is usually the fastest way to see what an integration is really doing.
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      const line = `${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started}ms)`;
      if (res.statusCode >= 400) {
        const from = req.socket.remoteAddress ?? 'unknown';
        log.warn(`${line} from ${from}`);
      } else {
        log.debug(line);
      }
    });
    next();
  });

  // Unauthenticated: liveness probe only.
  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'trustwestme', time: new Date().toISOString() });
  });

  // Everything else requires the API keypair.
  app.use(authenticate);
  app.use(routes);

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', message: `no route for ${req.method} ${req.path}` });
  });

  return app;
}

export function startServer() {
  const app = createServer();
  const server = app.listen(config.port, config.host, () => {
    log.info(`API listening on http://${config.host}:${config.port} (auth mode: ${config.authMode})`);
    if (!config.apiPublicKey) {
      log.warn('API_PUBLIC_KEY is not set — run `npm run keys` and put the pair in .env');
    }
  });

  // Without this, a port clash surfaces as an unhandled exception and a stack
  // trace that never names the actual problem.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log.error(`port ${config.port} is already in use. Most often this is the gateway `
        + `itself already running under systemd — check with "systemctl status gateway", `
        + `and use "systemctl restart gateway" rather than starting a second copy. `
        + `Otherwise another service owns the port: find it with `
        + `"ss -tlnp | grep :${config.port}" and either stop it or set a different `
        + `PORT in .env.`);
    } else if (err.code === 'EACCES') {
      log.error(`not allowed to bind port ${config.port}. Ports below 1024 need root; `
        + `pick a higher one in .env.`);
    } else {
      log.error('the API server could not start', err.message);
    }
    process.exit(1);
  });

  return server;
}
