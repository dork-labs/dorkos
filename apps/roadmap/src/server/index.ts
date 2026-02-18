import path from 'path';
import { createApp } from './app.js';
import { RoadmapStore } from './services/roadmap-store.js';
import { logger } from './lib/logger.js';

const port = Number(process.env.ROADMAP_PORT) || 4243;
const projectRoot = process.env.ROADMAP_PROJECT_ROOT || process.cwd();
const dataFile = path.join(projectRoot, 'roadmap.json');

const store = new RoadmapStore(dataFile);

async function main() {
  await store.init();
  logger.info(`Loaded roadmap data from ${dataFile}`);

  const app = createApp({ store, projectRoot });

  app.listen(port, () => {
    logger.info(`Server listening on port ${port}`);
  });
}

main().catch((err) => {
  logger.error('Failed to start server:', err);
  process.exit(1);
});
