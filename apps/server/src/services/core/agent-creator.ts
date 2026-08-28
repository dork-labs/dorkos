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
import { z } from 'zod';
import { ulid } from 'ulidx';
import { writeManifest, MANIFEST_DIR, MANIFEST_FILE } from '@dorkos/shared/manifest';
import { DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import { CreateAgentOptionsSchema } from '@dorkos/shared/mesh-schemas';
import type { AgentManifest, CreateAgentOptions } from '@dorkos/shared/mesh-schemas';
import {
  defaultSoulTemplate,
  defaultNopeTemplate,
  buildSoulContent,
  CONVENTION_FILES,
} from '@dorkos/shared/convention-files';
import { writeConventionFile } from '@dorkos/shared/convention-files-io';
import { defaultMemoryTemplate } from '@dorkos/memory';
import { renderTraits } from '@dorkos/shared/trait-renderer';
import { dorkbotClaudeMdTemplate } from '@dorkos/shared/dorkbot-templates';
import { scaffoldInstructions } from '@dorkos/harness';
import { seedOperatingSkills } from '@dorkos/operating-skills';
import { projectAgentWorkspace } from '../harness/project-agent-workspace.js';
import { validateBoundaryOrDorkHome, BoundaryError } from '../../lib/boundary.js';
import { resolveAgentsDirectory } from '../../lib/agents-home.js';
import { configManager } from './config-manager.js';
import { logConfigWrite } from './operator/config-write.js';
import { notifyAgentCreated } from './agent-created-hook.js';
import { ScaffoldLedger } from '../../lib/scaffold-ledger.js';
import { logger } from '../../lib/logger.js';
import type { SyncFromDiskResult } from '@dorkos/mesh';

/** Minimal MeshCore interface for sync-on-write. */
interface MeshCoreLike {
  syncFromDisk(projectPath: string): Promise<SyncFromDiskResult>;
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
 * Default canonical `AGENTS.md` body for a freshly created agent workspace.
 *
 * This is the cross-harness instruction source — every supported harness reads
 * it (directly, or via a generated pointer). It is written once and owned by the
 * user thereafter (never regenerated), so it is intentionally a fillable stub.
 *
 * @param displayName - The agent's display name for the heading.
 * @returns The default AGENTS.md body.
 */
function defaultAgentsTemplate(displayName: string): string {
  return [
    `# ${displayName}`,
    '',
    'This is an agent workspace managed by DorkOS.',
    '',
    "Describe this agent's purpose, responsibilities, and operating guidelines here.",
    'This file is the canonical, cross-harness instruction source — every supported',
    'harness (Claude Code, Codex, Cursor, Gemini, Copilot) reads it, directly or via',
    'a generated pointer.',
    '',
  ].join('\n');
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
      resolveAgentsDirectory(agentsConfig.defaultDirectory),
      currentDefault
    );
    // If the current default agent directory doesn't exist, adopt the new agent
    await fs.stat(path.join(defaultAgentDir, '.dork', 'agent.json'));
  } catch {
    // Default agent doesn't exist on disk — adopt the newly created agent
    const agentsConfig = configManager.get('agents');
    configManager.set('agents', { ...agentsConfig, defaultAgent: agentName });
    logConfigWrite('the agent creator', 'agents', agentsConfig, configManager.get('agents'));
  }
}

/**
 * Close `text` off as a sentence so the next one does not run into it.
 *
 * Error messages from other tools end however they end: `git clone https://x/y`
 * has no full stop, and running the cleanup sentence straight onto it reads as
 * one broken line.
 *
 * @param text - Text to finish
 * @returns The text with one closing full stop, if it needed one
 */
function endSentence(text: string): string {
  const trimmed = text.trimEnd();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * Undo a scaffold that failed partway through, and describe what is left.
 *
 * The two cases are deliberately different. When this run created the workspace
 * folder itself, the whole folder can go: nothing in it predates the run. When
 * the run scaffolded into a folder the user already had, only the ledger's
 * entries are removed, and the user's folder stays. That is the trade this
 * function exists to make: a leftover file is recoverable, a deleted folder is
 * not.
 *
 * Only paths this run can prove it created come off disk. That includes the
 * folders it made on the way in (`.agents/skills/`, `.claude/`, `.github/`),
 * because the writers that make them report them: a rollback that left those
 * behind would make the sentence this returns untrue. They are pruned only
 * while empty, so a folder holding anything else keeps itself and its parents,
 * and is named in the returned sentence.
 *
 * @param resolvedPath - Absolute path of the agent workspace
 * @param createdWorkspaceDir - Whether this run created that folder
 * @param ledger - Ledger of everything the run wrote inside an existing folder
 * @returns A plain-language sentence describing the state the folder is in
 */
async function undoScaffold(
  resolvedPath: string,
  createdWorkspaceDir: boolean,
  ledger: ScaffoldLedger
): Promise<string> {
  if (createdWorkspaceDir) {
    try {
      await fs.rm(resolvedPath, { recursive: true, force: true });
      return 'The new folder was removed.';
    } catch {
      return `The new folder ${resolvedPath} could not be removed, so you may want to delete it.`;
    }
  }

  const { kept } = await ledger.rollback();
  if (kept.length === 0) {
    return 'Your folder was kept, and the new files were removed.';
  }
  // Named relative to the folder the surrounding message already states, so a
  // long list stays readable in a toast.
  const inside = kept.map((entry) => path.relative(resolvedPath, entry) || entry);
  return `Your folder was kept, but these new files are still in it and you can delete them: ${inside.join(', ')}.`;
}

/**
 * Create a new agent workspace with scaffolded config files.
 *
 * Validates input, resolves directory, creates workspace directory, optionally
 * downloads a template, scaffolds agent.json/SOUL.md/NOPE.md, syncs to Mesh DB,
 * and auto-sets as default agent when appropriate.
 *
 * Scaffolding into a folder the user already has is allowed (only a `.dork/`
 * collision or a template request is refused), so failure cleanup is bounded to
 * what this run created. See {@link undoScaffold}. A failure that leaves
 * anything behind says so in the thrown error rather than deleting more.
 *
 * A seeded `persona` is written as SOUL.md's custom prose (below the trait
 * block); `capabilities` and `runtime` are recorded on the manifest as-is —
 * this is how a Shape's offered agent arrives fully shaped rather than blank.
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
 * @throws AgentCreationError on validation, collision, boundary, template, or
 * scaffold failures
 */
export async function createAgentWorkspace(
  input: unknown,
  meshCore?: MeshCoreLike
): Promise<AgentCreationResult> {
  // Validate input
  const parseResult = CreateAgentOptionsSchema.safeParse(input);
  if (!parseResult.success) {
    const flat = z.flattenError(parseResult.error);
    const messages = [
      ...Object.entries(flat.fieldErrors).map(([k, v]) => `${k}: ${(v as string[]).join(', ')}`),
      ...flat.formErrors,
    ].join('; ');
    throw new AgentCreationError(messages || 'Validation failed', 'VALIDATION', 400);
  }

  const opts: CreateAgentOptions = parseResult.data;
  // Everything this run creates inside a folder that already existed. Failure
  // cleanup removes these and only these.
  const ledger = new ScaffoldLedger();
  let createdWorkspaceDir = false;
  const agentsConfig = configManager.get('agents');
  const resolvedPath = opts.directory
    ? path.resolve(opts.directory)
    : path.resolve(resolveAgentsDirectory(agentsConfig.defaultDirectory), opts.name);

  // Boundary validation — agent-registry seam: marketplace-installed and system
  // agents live under `{dorkHome}/agents/*` by design, so dork-home is in-bounds.
  try {
    await validateBoundaryOrDorkHome(resolvedPath);
  } catch (err) {
    if (err instanceof BoundaryError) {
      throw new AgentCreationError(err.message, 'BOUNDARY', 403);
    }
    throw err;
  }

  if (!opts.skipTemplateDownload) {
    // Check whether the target directory already exists and what it contains
    let dirExists = false;
    try {
      await fs.stat(resolvedPath);
      dirExists = true;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // ENOENT — directory doesn't exist yet, will be created below
    }

    if (dirExists) {
      // Reject if directory already contains a .dork/ project
      const dorkPath = path.join(resolvedPath, '.dork');
      try {
        await fs.stat(dorkPath);
        throw new AgentCreationError(
          'Directory already contains a DorkOS project — use Import instead',
          'COLLISION',
          409
        );
      } catch (err: unknown) {
        if (err instanceof AgentCreationError) throw err;
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        // No .dork/ — directory is safe to scaffold into
      }

      // Templates need an empty directory (git clone creates its own content)
      if (opts.template) {
        throw new AgentCreationError(
          'Cannot apply template to an existing directory — use Start Blank or choose a new directory',
          'COLLISION',
          409
        );
      }
    } else {
      // Create parent directory (recursive) then agent directory (non-recursive)
      const parentDir = path.dirname(resolvedPath);
      await fs.mkdir(parentDir, { recursive: true });
      // Non-recursive: it succeeds only when this call is what created the
      // directory, which is what makes a full rollback of it safe later.
      await fs.mkdir(resolvedPath);
      createdWorkspaceDir = true;
    }
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
      // Templates are refused for existing directories above, so this always
      // rolls back a directory this run created.
      const cleanup = await undoScaffold(resolvedPath, createdWorkspaceDir, ledger);
      const message = templateErr instanceof Error ? templateErr.message : String(templateErr);
      throw new AgentCreationError(
        `Template download failed: ${endSentence(message)} ${cleanup}`,
        'TEMPLATE',
        500
      );
    }
  }

  let result: AgentCreationResult;
  try {
    // Create .dork/. Tolerates an existing directory so this works in both
    // modes: a fresh agent creation (where it doesn't exist) and a marketplace
    // install (where the package may already ship a `.dork/` directory). The
    // ledger records it only when this call is what created it.
    const dorkDir = path.join(resolvedPath, MANIFEST_DIR);
    await ledger.mkdir(dorkDir);

    // Scaffold agent.json
    const traits = opts.traits ?? DEFAULT_TRAITS;
    const conventions = opts.conventions ?? {
      soul: true,
      nope: true,
      memory: true,
      dorkosKnowledge: true,
    };

    const manifest: AgentManifest = {
      id: ulid(),
      name: opts.name,
      displayName: opts.displayName,
      description: opts.description ?? '',
      runtime: opts.runtime ?? 'claude-code',
      capabilities: opts.capabilities ?? [],
      // The emoji face chosen in the naming step (M3), or seeded from a
      // template — persisted so the agent's visual identity survives creation.
      ...(opts.icon ? { icon: opts.icon } : {}),
      // Written only when asked for. An absent key is what "inherit the server
      // default" looks like on disk, so writing the resolved value here instead
      // would freeze today's default into every agent ever created.
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.effort ? { effort: opts.effort } : {}),
      behavior: { responseMode: 'always' },
      traits,
      conventions,
      registeredAt: new Date().toISOString(),
      registeredBy: 'dorkos-ui',
      personaEnabled: true,
      isSystem: false,
      enabledToolGroups: {},
      // Managed MCP servers are added post-creation through the gated `mcp.*`
      // capabilities, never at scaffold time (a packaged agent may not ship
      // auto-injectable servers — ADR 260803-233420). A fresh agent starts empty.
      mcpServers: [],
      // A new agent works in its own folder. Written explicitly rather than
      // left to the schema default so the file says where the agent works
      // instead of leaving a reader to know that absence means "home".
      workspace: { mode: 'home' },
    };

    await ledger.claimFile(path.join(dorkDir, MANIFEST_FILE));
    await writeManifest(resolvedPath, manifest);

    // Scaffold SOUL.md. When a persona is seeded (e.g. a Shape's offered agent),
    // write it as the custom prose below the auto-generated trait block — the
    // same shape the persona→SOUL.md migration produces (`buildSoulContent`), so
    // there is one SOUL convention, not two. No persona → the default template.
    const traitBlock = renderTraits(traits);
    const soulContent = opts.persona
      ? buildSoulContent(traitBlock, opts.persona)
      : defaultSoulTemplate(manifest.displayName ?? manifest.name, traitBlock);
    await ledger.claimFile(path.join(dorkDir, 'SOUL.md'));
    await writeConventionFile(resolvedPath, 'SOUL.md', soulContent);

    // Scaffold NOPE.md
    const nopeContent = defaultNopeTemplate();
    await ledger.claimFile(path.join(dorkDir, 'NOPE.md'));
    await writeConventionFile(resolvedPath, 'NOPE.md', nopeContent);

    // Scaffold MEMORY.md — the agent's own notes, empty but explained. It is
    // claimed on the ledger like the other two, so a creation that fails later
    // takes the file with it: without the claim, the file outlives the failure
    // and the next agent created at this path inherits a stranger's notes.
    await ledger.claimFile(path.join(dorkDir, CONVENTION_FILES.memory));
    await writeConventionFile(resolvedPath, CONVENTION_FILES.memory, defaultMemoryTemplate());

    // Scaffold cross-harness instruction files (canonical AGENTS.md + per-harness
    // pointers) for every agent, not just DorkBot. Write-if-absent (ADR-0302), so a
    // template's own AGENTS.md/CLAUDE.md is never clobbered. DorkBot keeps its
    // orientation template as the canonical body; every other agent gets a fillable
    // default. This replaces the old DorkBot-only `.dork/AGENTS.md`, which nothing
    // read — the harness + agent discovery both read the root-level AGENTS.md.
    const agentsBody =
      opts.name === 'dorkbot'
        ? dorkbotClaudeMdTemplate()
        : defaultAgentsTemplate(manifest.displayName ?? manifest.name);
    const instructions = scaffoldInstructions(resolvedPath, { agentsBody });
    // Directories first: rollback works backwards, so the files inside a tree
    // are deleted before the tree itself is pruned.
    for (const relPath of instructions.createdDirs) {
      ledger.noteDirTree(path.join(resolvedPath, relPath));
    }
    for (const relPath of instructions.created) {
      ledger.noteFile(path.join(resolvedPath, relPath));
    }

    // Seed the Operating DorkOS skill pack into the new workspace's
    // .agents/skills/ so every agent knows how to run DorkOS. Idempotent and
    // version-stamped; best-effort so a seeding hiccup never fails creation.
    try {
      const seeded = await seedOperatingSkills(resolvedPath);
      for (const dir of seeded.createdDirs) {
        ledger.noteDirTree(dir);
      }
      for (const outcome of seeded.outcomes) {
        // Only 'created' is ours to undo. An 'upgraded' file was already on
        // disk before this run, so rollback leaves it: note that the seeder
        // did rewrite it, and rollback does not put the previous bytes back.
        // That is lossless in practice, because the seeder only upgrades a
        // file whose contents still match the hash of the pack version it was
        // seeded from, so what was overwritten was DorkOS's own older copy.
        if (outcome.action === 'created') {
          ledger.noteFile(path.join(seeded.skillsDir, outcome.name, 'SKILL.md'));
        }
      }
    } catch (err) {
      logger.warn('[agents] Failed to seed Operating DorkOS skill pack: %s', String(err));
    }

    // ADR-0043: sync to Mesh DB cache (best-effort)
    try {
      await meshCore?.syncFromDisk(resolvedPath);
    } catch {
      /* non-fatal */
    }

    // Auto-set as default agent when current default doesn't exist
    await maybeSetDefaultAgent(opts.name);

    // The agent-created seam: every creation path (HTTP routes, MCP
    // create_agent, marketplace agent install) funnels through this function,
    // so downstream reactions — e.g. re-binding Shape schedules that were
    // waiting on this agent — fire here. Awaited deliberately (the creation
    // response reflects settled reactions) but never throws.
    await notifyAgentCreated({
      id: manifest.id,
      name: manifest.name,
      displayName: manifest.displayName,
      path: resolvedPath,
      // This function IS the creation pipeline — it scaffolded the workspace a
      // few lines up, so the agent did not exist a moment ago.
      origin: 'created',
    });

    result = { manifest, path: resolvedPath, meta };
  } catch (scaffoldErr) {
    if (scaffoldErr instanceof AgentCreationError) throw scaffoldErr;

    const cleanup = await undoScaffold(resolvedPath, createdWorkspaceDir, ledger);
    const reason = scaffoldErr instanceof Error ? scaffoldErr.message : String(scaffoldErr);
    logger.error('[agents] Scaffold failed for "%s": %s', opts.name, reason);
    throw new AgentCreationError(
      `Could not finish setting up the agent in ${resolvedPath}. ${cleanup} Reason: ${endSentence(reason)}`,
      'SCAFFOLD',
      500
    );
  }

  // Link the seeded skills into the layout each harness reads, so a Claude Code
  // session in this workspace can actually load them (DOR-659). Deliberately
  // OUTSIDE the rollback-protected block above: the ledger only removes files
  // and empty directories, so a symlink it created would survive a rollback and
  // then keep `.claude/` from being pruned, stranding a half-built workspace.
  // Nothing past this point can fail, so nothing has to be undone.
  projectAgentWorkspace(resolvedPath);

  return result;
}
