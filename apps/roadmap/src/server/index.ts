import path from 'path';
import { createApp } from './app.js';
import { RoadmapStore } from './services/roadmap-store.js';
import { logger } from './lib/logger.js';
import { env } from './env.js';

const port = env.ROADMAP_PORT;
const projectRoot = env.ROADMAP_PROJECT_ROOT;
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
