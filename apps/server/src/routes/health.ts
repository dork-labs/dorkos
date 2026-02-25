import { Router } from 'express';
import { createRequire } from 'module';
import { tunnelManager } from '../services/core/tunnel-manager.js';

declare const __CLI_VERSION__: string | undefined;

// Use build-time injected version when bundled; fall back to root package.json in dev mode
let SERVER_VERSION: string;
if (typeof __CLI_VERSION__ !== 'undefined') {
  SERVER_VERSION = __CLI_VERSION__;
} else {
  const req = createRequire(import.meta.url);
  SERVER_VERSION = (req('../../package.json') as { version: string }).version;
}

const router = Router();

router.get('/', (_req, res) => {
  const response: Record<string, unknown> = {
    status: 'ok',
    version: SERVER_VERSION,
    uptime: process.uptime(),
  };

  const tunnelStatus = tunnelManager.status;
  if (tunnelStatus.enabled) {
    response.tunnel = {
      connected: tunnelStatus.connected,
      url: tunnelStatus.url,
      port: tunnelStatus.port,
      startedAt: tunnelStatus.startedAt,
    };
  }

  res.json(response);
});

export default router;
