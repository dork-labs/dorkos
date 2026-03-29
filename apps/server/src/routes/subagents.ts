import { Router } from 'express';
import { runtimeRegistry } from '../services/core/runtime-registry.js';

const router = Router();

/** GET /api/subagents — list available subagents reported by the SDK. */
router.get('/', async (_req, res) => {
  const runtime = runtimeRegistry.getDefault();
  const subagents = await runtime.getSupportedSubagents();
  res.json({ subagents });
});

export default router;
