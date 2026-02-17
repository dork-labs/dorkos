import fs from 'fs/promises';
import path from 'path';
import matter from 'gray-matter';
import type { CommandEntry, CommandRegistry } from '@dorkos/shared/types';
import { logger } from '../lib/logger.js';

/**
 * Fallback frontmatter parser for when gray-matter's YAML parser fails
 * (e.g. unquoted values with brackets, colons, pipes).
 * Extracts simple key: value pairs from the frontmatter block.
 */
function parseFrontmatterFallback(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};

  const result: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    if (key && val) result[key] = val;
  }
  return result;
}

/**
 * Scans `.claude/commands/` for slash command definitions.
 *
 * Parses YAML frontmatter (description, allowed-tools, argument-hint) via gray-matter
 * with a fallback parser for malformed YAML. Results are cached until `invalidateCache()`.
 */
class CommandRegistryService {
  private cache: CommandRegistry | null = null;
  private readonly commandsDir: string;

  /** @param vaultRoot - Must be pre-validated against directory boundary by caller */
  constructor(vaultRoot: string) {
    this.commandsDir = path.join(vaultRoot, '.claude', 'commands');
  }

  async getCommands(forceRefresh = false): Promise<CommandRegistry> {
    if (this.cache && !forceRefresh) return this.cache;

    const commands: CommandEntry[] = [];

    try {
      const entries = await fs.readdir(this.commandsDir, {
        withFileTypes: true,
      });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const nsPath = path.join(this.commandsDir, entry.name);
        const files = await fs.readdir(nsPath);

        for (const file of files) {
          if (!file.endsWith('.md')) continue;

          const filePath = path.join(nsPath, file);
          try {
            const content = await fs.readFile(filePath, 'utf-8');

            let frontmatter: Record<string, unknown>;
            try {
              frontmatter = matter(content).data;
            } catch {
              // YAML parse failed (e.g. unquoted brackets/colons) — use simple fallback
              frontmatter = parseFrontmatterFallback(content);
            }

            const commandName = file.replace('.md', '');
            const allowedToolsRaw = frontmatter['allowed-tools'];
            commands.push({
              namespace: entry.name,
              command: commandName,
              fullCommand: `/${entry.name}:${commandName}`,
              description: (frontmatter.description as string) || '',
              argumentHint: frontmatter['argument-hint'] as string | undefined,
              allowedTools:
                typeof allowedToolsRaw === 'string'
                  ? allowedToolsRaw.split(',').map((t: string) => t.trim())
                  : (allowedToolsRaw as string[] | undefined),
              filePath: path.relative(process.cwd(), filePath),
            });
          } catch (fileErr) {
            logger.warn(
              `[CommandRegistry] Skipping ${entry.name}/${file}: ${(fileErr as Error).message}`
            );
          }
        }
      }
    } catch (err) {
      // Commands directory might not exist
      logger.warn('[CommandRegistry] Could not read commands directory:', (err as Error).message);
    }

    commands.sort((a, b) => a.fullCommand.localeCompare(b.fullCommand));

    this.cache = { commands, lastScanned: new Date().toISOString() };
    return this.cache;
  }

  invalidateCache(): void {
    this.cache = null;
  }
}

export { CommandRegistryService };
