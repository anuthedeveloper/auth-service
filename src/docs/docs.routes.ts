import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { getOpenApiDocument } from './openapi';

export const docsRouter = Router();

/** The machine-readable spec, for client generators, Postman, linters and so on. */
docsRouter.get('/openapi.json', (_req, res) => {
  res.json(getOpenApiDocument());
});

/** Interactive documentation. Served from this app's own files, so it works without a CDN. */
docsRouter.use(
  '/docs',
  swaggerUi.serve,
  swaggerUi.setup(getOpenApiDocument(), {
    customSiteTitle: 'Auth Service API',
    swaggerOptions: { persistAuthorization: true },
  }),
);
