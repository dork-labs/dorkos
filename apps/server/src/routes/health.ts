import { Router } from 'express';
import { tunnelManager } from '../services/tunnel-manager.js';

const router = Router();

router.get('/', (_req, res) => {
  const response: Record<string, unknown> = {
    status: 'ok',
    version: '1.0.0',
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
