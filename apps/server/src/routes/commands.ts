import { Router } from 'express';
import { CommandRegistryService } from '../services/command-registry.js';
import { CommandsQuerySchema } from '@lifeos/shared/schemas';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vaultRoot = path.resolve(__dirname, '../../../../');
const registry = new CommandRegistryService(vaultRoot);
const router = Router();

// GET /api/commands - List all commands (with optional refresh)
router.get('/', async (req, res) => {
  const parsed = CommandsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid query', details: parsed.error.format() });
  }
  const refresh = parsed.data.refresh === 'true';
  const commands = await registry.getCommands(refresh);
  res.json(commands);
});

export default router;
