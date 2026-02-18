import express from 'express';
import cors from 'cors';
import type { RoadmapStore } from './services/roadmap-store.js';
import { createItemsRouter } from './routes/items.js';
import { createMetaRouter } from './routes/meta.js';
import { createFilesRouter } from './routes/files.js';

interface CreateAppOptions {
  store: RoadmapStore;
  projectRoot: string;
}

/**
 * Create and configure the Express application.
 *
 * @param options - Store instance and project root for file serving
 */
export function createApp(options: CreateAppOptions) {
  const { store, projectRoot } = options;
  const app = express();

  app.use(cors());
  app.use(express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api/roadmap/items', createItemsRouter(store));
  app.use('/api/roadmap/meta', createMetaRouter(store));
  app.use('/api/roadmap/files', createFilesRouter(projectRoot));

  return app;
}
