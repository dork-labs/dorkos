import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { createApp } from './app.js';
import { agentManager } from './services/agent-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../../../.env') });

const PORT = parseInt(process.env.GATEWAY_PORT || '6942', 10);

async function start() {
  const app = createApp();
  app.listen(PORT, 'localhost', () => {
    console.log(`Gateway server running on http://localhost:${PORT}`);
  });

  // Run session health check every 5 minutes
  setInterval(() => {
    agentManager.checkSessionHealth();
  }, 5 * 60 * 1000);
}

start();
