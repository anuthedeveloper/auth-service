import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import pinoHttp from 'pino-http';
import { env } from './config/env';
import { logger } from './utils/logger';
import { healthRouter } from './routes/health';
import { authRouter } from './modules/auth/auth.routes';
import { adminRouter } from './modules/admin/admin.routes';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { globalLimiter } from './middleware/rateLimiters';
import { docsRouter } from './docs/docs.routes';

export function createApp(): express.Express {
  const app = express();

  app.disable('x-powered-by');
  // Behind a reverse proxy, req.ip is the proxy's address unless told how many hops to trust.
  // Trusting too many lets clients spoof X-Forwarded-For and dodge rate limits (see README).
  if (env.TRUST_PROXY > 0) {
    app.set('trust proxy', env.TRUST_PROXY);
  }
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN === '*' ? true : env.CORS_ORIGIN.split(',') }));
  app.use(globalLimiter);
  app.use(express.json({ limit: '100kb' }));
  app.use(pinoHttp({ logger, autoLogging: env.NODE_ENV !== 'test' }));

  app.use(healthRouter);
  // Public API docs are off by default in production; set API_DOCS_ENABLED=true to publish them.
  if (env.API_DOCS_ENABLED ?? env.NODE_ENV !== 'production') {
    app.use(docsRouter);
  }
  app.use('/auth', authRouter);
  app.use('/admin', adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
