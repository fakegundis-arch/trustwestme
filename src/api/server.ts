import express from 'express';
import { config } from '../config';
import { authenticate } from './auth';
import { routes } from './routes';
import { logger } from '../util/log';

const log = logger('http');

export function createServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));

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
      log.error(`port ${config.port} is already in use — another service is listening on it `
        + `(often the website itself). Set PORT to a free port in .env, for example PORT=8787, `
        + `then restart and point your site at the new port.`);
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
