/**
 * Agent workspace creation service — shared pipeline for creating new agent
 * workspaces with scaffolded config files.
 *
 * Used by both the HTTP POST /api/agents/create endpoint and the MCP
 * `create_agent` tool. Extracts the full creation pipeline (mkdir, scaffold,
 * template download, mesh sync) into a reusable service function.
 *
 * @module services/core/agent-creator
 */
import fs from 'fs/promises';
import path from 'path';
import { ulid } from 'ulidx';
import { writeManifest } from '@dorkos/shared/manifest';
import { CreateAgentOptionsSchema } from '@dorkos/shared/mesh-schemas';
import type { AgentManifest, CreateAgentOptions } from '@dorkos/shared/mesh-schemas';
import { defaultSoulTemplate, defaultNopeTemplate } from '@dorkos/shared/convention-files';
import { writeConventionFile } from '@dorkos/shared/convention-files-io';
import { renderTraits } from '@dorkos/shared/trait-renderer';
import { dorkbotClaudeMdTemplate } from '@dorkos/shared/dorkbot-templates';
import { validateBoundary, expandTilde, BoundaryError } from '../../lib/boundary.js';
import { configManager } from './config-manager.js';
import { logger } from '../../lib/logger.js';

/** Minimal MeshCore interface for sync-on-write. */
interface MeshCoreLike {
  syncFromDisk(projectPath: string): Promise<boolean>;
}

/** Error thrown when agent creation fails due to a known condition. */
export class AgentCreationError extends Error {
  constructor(
    message: string,
    public readonly code: 'VALIDATION' | 'COLLISION' | 'BOUNDARY' | 'SCAFFOLD' | 'TEMPLATE',
    public readonly statusCode: number = 400
  ) {
    super(message);
    this.name = 'AgentCreationError';
  }
}

/** Metadata returned alongside the manifest after creation. */
export interface AgentCreationMeta {
  hasPostInstall: boolean;
  templateMethod: string;
}

/** Result of a successful agent creation. */
export interface AgentCreationResult {
  manifest: AgentManifest;
  path: string;
  /** Present when a template was used. */
  meta?: AgentCreationMeta;
}

/**
 * Check whether a directory contains a package.json with post-install hooks.
 *
 * Detects `postinstall`, `setup`, and `prepare` scripts that the user
 * may need to run after template download.
 *
 * @param dir - Directory to check for package.json
 * @returns True if a post-install hook script is present
 */
async function checkForPostInstallHook(dir: string): Promise<boolean> {
  try {
    const pkgPath = path.join(dir, 'package.json');
    const raw = await fs.readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw);
    return !!(pkg.scripts?.postinstall || pkg.scripts?.setup || pkg.scripts?.prepare);
  } catch {
    return false;
  }
}

/**
 * Auto-set the newly created agent as default when the current default doesn't exist on disk.
 *
 * @param agentName - Name of the newly created agent
 */
async function maybeSetDefaultAgent(agentName: string): Promise<void> {
  try {
    const agentsConfig = configManager.get('agents');
    const currentDefault = agentsConfig.defaultAgent;
    const defaultAgentDir = path.resolve(
      expandTilde(agentsConfig.defaultDirectory),
      currentDefault
    );
    // If the current default agent directory doesn't exist, adopt the new agent
    await fs.stat(path.join(defaultAgentDir, '.dork', 'agent.json'));
  } catch {
    // Default agent doesn't exist on disk — adopt the newly created agent
    const agentsConfig = configManager.get('agents');
    configManager.set('agents', { ...agentsConfig, defaultAgent: agentName });
    logger.debug(`[agents] Auto-set default agent to "${agentName}"`);
  }
}

/**
 * Create a new agent workspace with scaffolded config files.
 *
 * Validates input, resolves directory, creates workspace directory, optionally
 * downloads a template, scaffolds agent.json/SOUL.md/NOPE.md, syncs to Mesh DB,
 * and auto-sets as default agent when appropriate. Rolls back the created
 * directory on any failure.
 *
 * When `opts.skipTemplateDownload` is true, the function assumes `directory`
 * already exists on disk and is pre-populated with the agent's template
 * contents (used by the marketplace install pipeline after copying a package
 * onto disk). In that mode the collision check, parent/agent `mkdir` calls,
 * and template-download branch are all skipped — only the scaffold pipeline
 * runs against the existing directory.
 *
 * @param input - Raw input to validate with CreateAgentOptionsSchema
 * @param meshCore - Optional MeshCore instance for DB sync after creation
 * @returns The created agent manifest, resolved path, and optional template meta
 * @throws AgentCreationError on validation, collision, boundary, or template failures
 */
export async function createAgentWorkspace(
  input: unknown,
  meshCore?: MeshCoreLike
): Promise<AgentCreationResult> {
  // Validate input
  const parseResult = CreateAgentOptionsSchema.safeParse(input);
  if (!parseResult.success) {
    const flat = parseResult.error.flatten();
    const messages = [
      ...Object.entries(flat.fieldErrors).map(([k, v]) => `${k}: ${(v as string[]).join(', ')}`),
      ...flat.formErrors,
    ].join('; ');
    throw new AgentCreationError(messages || 'Validation failed', 'VALIDATION', 400);
  }

  const opts: CreateAgentOptions = parseResult.data;
  const agentsConfig = configManager.get('agents');
  const resolvedPath = opts.directory
    ? path.resolve(opts.directory)
    : path.resolve(expandTilde(agentsConfig.defaultDirectory), opts.name);

  // Boundary validation
  try {
    await validateBoundary(resolvedPath);
  } catch (err) {
    if (err instanceof BoundaryError) {
      throw new AgentCreationError(err.message, 'BOUNDARY', 403);
    }
    throw err;
  }

  if (!opts.skipTemplateDownload) {
    // Check collision — directory must not already exist
    try {
      await fs.stat(resolvedPath);
      throw new AgentCreationError('Directory already exists', 'COLLISION', 409);
    } catch (err: unknown) {
      if (err instanceof AgentCreationError) throw err;
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // ENOENT is expected — directory doesn't exist yet
    }

    // Create parent directory (recursive) then agent directory (non-recursive)
    const parentDir = path.dirname(resolvedPath);
    await fs.mkdir(parentDir, { recursive: true });
    await fs.mkdir(resolvedPath);
  }

  // Template download (git clone with giget fallback)
  let meta: AgentCreationMeta | undefined;

  if (opts.template && !opts.skipTemplateDownload) {
    try {
      const { downloadTemplate } = await import('./template-downloader.js');
      await downloadTemplate(opts.template, resolvedPath);
      const hasPostInstall = await checkForPostInstallHook(resolvedPath);
      meta = { hasPostInstall, templateMethod: 'git' };
    } catch (templateErr) {
      // Rollback: remove the created directory on template failure
      try {
        await fs.rm(resolvedPath, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
      const message = templateErr instanceof Error ? templateErr.message : String(templateErr);
      throw new AgentCreationError(`Template download failed: ${message}`, 'TEMPLATE', 500);
    }
  }

  try {
    // Create .dork/ subdirectory. Recursive so this works in both modes:
    // a fresh agent creation (where the dir doesn't exist) and a marketplace
    // install (where the package may already ship a `.dork/` directory).
    const dorkDir = path.join(resolvedPath, '.dork');
    await fs.mkdir(dorkDir, { recursive: true });

    // Scaffold agent.json
    const traits = opts.traits ?? {
      tone: 3,
      autonomy: 3,
      caution: 3,
      communication: 3,
      creativity: 3,
    };
    const conventions = opts.conventions ?? {
      soul: true,
      nope: true,
      dorkosKnowledge: true,
    };

    const manifest: AgentManifest = {
      id: ulid(),
      name: opts.name,
      description: opts.description ?? '',
      runtime: opts.runtime ?? 'claude-code',
      capabilities: [],
      behavior: { responseMode: 'always' },
      budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
      traits,
      conventions,
      registeredAt: new Date().toISOString(),
      registeredBy: 'dorkos-ui',
      personaEnabled: true,
      isSystem: false,
      enabledToolGroups: {},
    };

    await writeManifest(resolvedPath, manifest);

    // Scaffold SOUL.md
    const traitBlock = renderTraits(traits);
    const soulContent = defaultSoulTemplate(manifest.name, traitBlock);
    await writeConventionFile(resolvedPath, 'SOUL.md', soulContent);

    // Scaffold NOPE.md
    const nopeContent = defaultNopeTemplate();
    await writeConventionFile(resolvedPath, 'NOPE.md', nopeContent);

    // DorkBot gets an additional AGENTS.md
    if (opts.name === 'dorkbot') {
      const claudeMd = dorkbotClaudeMdTemplate();
      await fs.writeFile(path.join(dorkDir, 'AGENTS.md'), claudeMd, 'utf-8');
    }

    // ADR-0043: sync to Mesh DB cache (best-effort)
    try {
      await meshCore?.syncFromDisk(resolvedPath);
    } catch {
      /* non-fatal */
    }

    // Auto-set as default agent when current default doesn't exist
    await maybeSetDefaultAgent(opts.name);

    return { manifest, path: resolvedPath, meta };
  } catch (scaffoldErr) {
    // Rollback: remove the created directory on scaffold failure
    if (!(scaffoldErr instanceof AgentCreationError)) {
      try {
        await fs.rm(resolvedPath, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
    throw scaffoldErr;
  }
}
