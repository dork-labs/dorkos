import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { apiReference } from '@scalar/express-api-reference';
import sessionRoutes from './routes/sessions.js';
import commandRoutes from './routes/commands.js';
import healthRoutes from './routes/health.js';
import directoryRoutes from './routes/directory.js';
import configRoutes from './routes/config.js';
import fileRoutes from './routes/files.js';
import gitRoutes from './routes/git.js';
import tunnelRoutes from './routes/tunnel.js';
import { generateOpenAPISpec } from './services/core/openapi-registry.js';
import { errorHandler } from './middleware/error-handler.js';
import { requestLogger } from './middleware/request-logger.js';
import { env } from './env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.use(requestLogger);

  // API routes
  app.use('/api/sessions', sessionRoutes);
  app.use('/api/commands', commandRoutes);
  app.use('/api/health', healthRoutes);
  app.use('/api/directory', directoryRoutes);
  app.use('/api/config', configRoutes);
  app.use('/api/files', fileRoutes);
  app.use('/api/git', gitRoutes);
  app.use('/api/tunnel', tunnelRoutes);

  // OpenAPI spec + interactive docs
  const spec = generateOpenAPISpec();
  app.get('/api/openapi.json', (_req, res) => res.json(spec));
  app.use('/api/docs', apiReference({ content: spec }));

  // Error handler (must be after routes)
  app.use(errorHandler);

  // In production, serve the built React app
  if (env.NODE_ENV === 'production') {
    const distPath = env.CLIENT_DIST_PATH ?? path.join(__dirname, '../../client/dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  return app;
}
