import { Router } from 'express';
import { tunnelManager } from '../services/tunnel-manager.js';
import { resolveClaudeCliPath } from '../services/agent-manager.js';

const router = Router();

router.get('/', (_req, res) => {
  let claudeCliPath: string | null = null;
  try {
    claudeCliPath = resolveClaudeCliPath() ?? null;
  } catch {}

  const tunnel = tunnelManager.status;

  res.json({
    version: '1.0.0',
    port: parseInt(process.env.GATEWAY_PORT || '6942', 10),
    uptime: process.uptime(),
    workingDirectory: process.cwd(),
    nodeVersion: process.version,
    claudeCliPath,
    tunnel: {
      enabled: tunnel.enabled,
      connected: tunnel.connected,
      url: tunnel.url,
      authEnabled: !!process.env.TUNNEL_AUTH,
      tokenConfigured: !!process.env.NGROK_AUTHTOKEN,
    },
  });
});

export default router;
