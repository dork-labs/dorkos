import { Router } from 'express';
import { agentManager } from '../services/core/agent-manager.js';

const router = Router();

/** GET /api/models — list available Claude models. */
router.get('/', async (_req, res) => {
  const models = await agentManager.getSupportedModels();
  res.json({ models });
});

export default router;
