import { Router } from 'express';
import { CommandRegistryService } from '../services/core/command-registry.js';
import { CommandsQuerySchema } from '@dorkos/shared/schemas';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateBoundary, BoundaryError } from '../lib/boundary.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = process.env.DORKOS_DEFAULT_CWD ?? path.resolve(__dirname, '../../../../');
const registryCache = new Map<string, CommandRegistryService>();

function getRegistry(cwd?: string): CommandRegistryService {
  const root = cwd || defaultRoot;
  let registry = registryCache.get(root);
  if (!registry) {
    registry = new CommandRegistryService(root);
    registryCache.set(root, registry);
  }
  return registry;
}

const router = Router();

// GET /api/commands - List all commands (with optional refresh and cwd)
router.get('/', async (req, res) => {
  const parsed = CommandsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: parsed.error.format() });
  }
  const refresh = parsed.data.refresh === 'true';
  try {
    let validatedCwd: string | undefined;
    if (parsed.data.cwd) {
      validatedCwd = await validateBoundary(parsed.data.cwd);
    }
    const registry = getRegistry(validatedCwd);
    const commands = await registry.getCommands(refresh);
    res.json(commands);
  } catch (err) {
    if (err instanceof BoundaryError) {
      return res.status(403).json({ error: err.message, code: err.code });
    }
    throw err;
  }
});

export default router;
