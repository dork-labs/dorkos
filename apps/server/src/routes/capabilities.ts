/**
 * `GET /api/capabilities` — the per-runtime capability matrix.
 *
 * It shares the `/api/capabilities` prefix with the registry catalog
 * (`routes/capabilities-catalog.ts`) and the invoke endpoint
 * (`routes/capabilities-invoke.ts`); `http/hono-api.ts` mounts all three.
 *
 * @module routes/capabilities
 */
import { Hono } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';

const router = new Hono<ApiEnv>();

/**
 * GET /api/capabilities — returns capabilities for all registered runtimes.
 *
 * Response shape: `{ capabilities: Record<string, RuntimeCapabilities>, defaultRuntime: string }`
 */
router.get('/', (c) => {
  const capabilities = runtimeRegistry.getAllCapabilities();
  const defaultRuntime = runtimeRegistry.getDefaultType();
  return c.json({ capabilities, defaultRuntime });
});

export default router;
