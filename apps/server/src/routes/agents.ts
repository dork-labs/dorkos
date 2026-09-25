/**
 * Agent identity routes -- always available, independent of Mesh.
 *
 * Provides CRUD for `.dork/agent.json` files via the shared manifest module.
 * All path parameters are boundary-validated.
 *
 * ADR-0043: when MeshCore is provided, POST and PATCH handlers call
 * `meshCore.syncFromDisk()` after writing the manifest to keep the
 * Mesh DB cache in sync without waiting for the 5-min reconciler.
 *
 * ## Who the Activity feed says registered an agent
 *
 * Both creation routes are open to agents on purpose — `create_agent` is tier
 * `act` in `MCP_TOOL_TIERS`, and `dorkos agent create` reaches `POST /create`
 * over HTTP carrying the caller's `X-DorkOS-Agent` token whenever DorkOS spawned
 * it. So they read WHO asked (`readActivityActor`) rather than asserting the
 * person did it; before DOR-1829 both hardcoded `user` / `'You'`, and an agent
 * that registered another agent appeared in the operator's own feed as something
 * they had done themselves. No person bar was added here for the same reason the
 * attribution had to be fixed: the caller may legitimately be a machine.
 *
 * @module routes/agents
 */
import { Router, type Request, type Response } from 'express';
import fs from 'fs/promises';
import { z } from 'zod';
import path from 'path';
import { ulid } from 'ulidx';
import { readManifest, writeManifest } from '@dorkos/shared/manifest';
import { seedAgentFace } from '@dorkos/shared/agent-face';
import { ResolveAgentsRequestSchema, CreateAgentRequestSchema } from '@dorkos/shared/mesh-schemas';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import {
  buildSoulContent,
  defaultSoulTemplate,
  defaultNopeTemplate,
  CONVENTION_FILES,
} from '@dorkos/shared/convention-files';
import { readConventionFile, writeConventionFile } from '@dorkos/shared/convention-files-io';
import { defaultMemoryTemplate } from '@dorkos/memory';
import { renderTraits, DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import { validateBoundaryOrDorkHome, BoundaryError } from '../lib/boundary.js';
import { createAgentWorkspace, AgentCreationError } from '../services/core/agent-creator.js';
import { updateAgentManifest, AgentUpdateError } from '../services/core/operator/agent-updater.js';
import { notifyAgentCreated } from '../services/core/agent-created-hook.js';
import { resolveNamedAgentIdentity } from '../services/mesh/normalize-agent-identity.js';
import { logger } from '../lib/logger.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import { readActivityActor } from '../services/activity/activity-actor.js';
import type { SyncFromDiskResult } from '@dorkos/mesh';
import { trustedCaller } from '../services/core/capabilities/index.js';
import { readCallerAuthority } from '../lib/caller-authority.js';
import { getRequestAgentIdentity } from '../middleware/agent-identity.js';
import { resolveAgentsDirectory } from '../lib/agents-home.js';
import { configManager } from '../services/core/config-manager.js';
import {
  cardTemplateGate,
  personTemplateGate,
  TemplateApprovalPendingError,
  TemplateDeclinedError,
  TemplateNeedsReviewError,
  type TemplateGate,
  type TemplateInspection,
} from '../services/core/agent-templates/template-gate.js';
import type { ConfirmationProvider } from '../services/marketplace-mcp/confirmation-provider.js';
import { DisclosedEffectsSchema } from '../services/marketplace/disclosed-effects.js';
import { computeTargetDir } from '../services/marketplace/flows/install-agent.js';
import {
  DisclosureChangedError,
  InvalidPackageError,
  type MarketplaceInstaller,
} from '../services/marketplace/marketplace-installer.js';
import { CreateAgentOptionsSchema } from '@dorkos/shared/mesh-schemas';
import { PackageNameSchema } from '@dorkos/marketplace';

/** Minimal MeshCore interface for sync-on-write. */
interface MeshCoreLike {
  syncFromDisk(projectPath: string): Promise<SyncFromDiskResult>;
}

/**
 * What agent creation reads from services composed later in boot (DOR-2325).
 * Read lazily, per request: the marketplace's confirmation provider is built
 * after this router is mounted.
 */
export interface AgentCreationDeps {
  /** The provider that raises a card when an agent creates from a template. */
  confirmationProvider?: () => ConfirmationProvider | undefined;
  /**
   * The marketplace installer and data directory, for creating an agent from a
   * marketplace package (DOR-2325). Absent while the marketplace is off.
   */
  marketplace?: () =>
    { installer: Pick<MarketplaceInstaller, 'install'>; dorkHome: string } | undefined;
}

/**
 * A marketplace agent package to create the agent from, with exactly what the
 * person was shown (DOR-2325): the installer stages it once, validates it,
 * holds it to this disclosure and these files, and creates the agent from the
 * staged copy.
 */
const PackageCreationSchema = z
  .object({
    // A listed package's name, never a path or an address: it also names the
    // folder the agent lands in, checked for a collision before the install.
    name: PackageNameSchema,
    marketplace: z.string().min(1).optional(),
    approvedDisclosure: DisclosedEffectsSchema,
    approvedContentHash: z.string().min(1),
  })
  .strict();

/** The identity a person chose in the creation flow, applied to a package's agent. */
const PackageAgentIdentitySchema = CreateAgentOptionsSchema.pick({
  displayName: true,
  icon: true,
  color: true,
  persona: true,
  runtime: true,
  capabilities: true,
  model: true,
  effort: true,
});

/** Body fields `/create` reads itself, never passed to the creator. */
const TemplateDecisionSchema = z.object({
  /** The content hash a person was shown on a `template_needs_review` answer. */
  approvedTemplateHash: z.string().min(1).optional(),
  /** The token from an agent's earlier `requires_confirmation` answer. */
  confirmationToken: z.string().min(1).optional(),
});

/**
 * What a template brings, as a response carries it: every harness file with
 * its reason, and what its skills run and may do without asking.
 */
function templateOf(inspection: TemplateInspection) {
  return {
    source: inspection.source,
    contentHash: inspection.contentHash,
    findings: inspection.findings,
    settings: inspection.settings,
    disclosed: inspection.disclosed,
  };
}

/** Whether anything exists at `p`. */
async function pathExists(p: string): Promise<boolean> {
  return fs.lstat(p).then(
    () => true,
    () => false
  );
}

/**
 * Where `createAgentWorkspace` will put an agent, worked out the same way, so a
 * card names the folder the agent really lands in.
 */
function landingDirectory(body: { name?: unknown; directory?: unknown }): string {
  if (typeof body.directory === 'string' && body.directory.length > 0) {
    return path.resolve(body.directory);
  }
  return path.resolve(
    resolveAgentsDirectory(configManager.get('agents').defaultDirectory),
    typeof body.name === 'string' ? body.name : ''
  );
}

/**
 * Create the agents router for agent identity CRUD.
 *
 * @param meshCore - Optional MeshCore instance for DB sync after writes
 * @param deps - Services agent creation reads lazily (DOR-2325)
 * @returns Express Router with agent identity endpoints
 */
export function createAgentsRouter(meshCore?: MeshCoreLike, deps: AgentCreationDeps = {}): Router {
  const router = Router();

  // GET /api/agents/current?path=/path/to/project
  // Returns the agent manifest for the given directory, or null
  router.get('/current', async (req, res) => {
    try {
      const rawPath = req.query.path as string;
      if (!rawPath) {
        return res.status(400).json({ error: 'path query parameter required' });
      }
      const agentPath = await validateBoundaryOrDorkHome(rawPath);
      const manifest = await readManifest(agentPath);
      if (!manifest) {
        return res.json(null);
      }

      // Include convention file contents alongside manifest data
      const soulContent = await readConventionFile(agentPath, CONVENTION_FILES.soul);
      const nopeContent = await readConventionFile(agentPath, CONVENTION_FILES.nope);
      // Read alongside the other two, so the editor that PATCHes `memoryContent`
      // can read back what it saved. Without this the round trip is broken in
      // the direction a person notices last: the save appears to work and the
      // field comes back empty on the next load.
      const memoryContent = await readConventionFile(agentPath, CONVENTION_FILES.memory);

      return res.json({ ...manifest, soulContent, nopeContent, memoryContent });
    } catch (err) {
      if (err instanceof BoundaryError) {
        return res.status(403).json({ error: err.message, code: err.code });
      }
      logger.error('[agents] GET /current failed', { err });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/agents/resolve
  // Batch resolve agents for multiple paths (avoids N+1 in DirectoryPicker)
  router.post('/resolve', async (req, res) => {
    try {
      const result = ResolveAgentsRequestSchema.safeParse(req.body);
      if (!result.success) {
        return res
          .status(400)
          .json({ error: 'Validation failed', details: z.flattenError(result.error) });
      }
      const agents: Record<string, AgentManifest | null> = {};
      await Promise.all(
        result.data.paths.map(async (p) => {
          try {
            const resolvedP = await validateBoundaryOrDorkHome(p);
            agents[p] = await readManifest(resolvedP);
          } catch {
            agents[p] = null;
          }
        })
      );
      return res.json({ agents });
    } catch (err) {
      logger.error('[agents] POST /resolve failed', { err });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/agents
  // Create a new agent (writes .dork/agent.json)
  router.post('/', async (req, res) => {
    try {
      const result = CreateAgentRequestSchema.safeParse(req.body);
      if (!result.success) {
        return res
          .status(400)
          .json({ error: 'Validation failed', details: z.flattenError(result.error) });
      }
      const { path: rawAgentPath, name, displayName, description, runtime } = result.data;
      const agentPath = await validateBoundaryOrDorkHome(rawAgentPath);

      // Check if agent already exists
      const existing = await readManifest(agentPath);
      if (existing) {
        return res
          .status(409)
          .json({ error: 'Agent already exists at this path', agent: existing });
      }

      // The same identity gate the mesh register route and the `mesh_register`
      // tool use. Two bugs here, both DOR-2054: `displayName` was accepted by
      // the request schema and then dropped on the floor, and `name` was written
      // through unslugified, so a person naming an agent "My Bot" from this
      // route got that string as the immutable slug an `@handle` derives from.
      const identity = resolveNamedAgentIdentity({ name, displayName }, path.basename(agentPath));
      if (!identity.ok) {
        return res.status(400).json({ error: identity.error, code: identity.code });
      }

      const id = ulid();
      const manifest: AgentManifest = {
        id,
        name: identity.identity.name,
        displayName: identity.identity.displayName,
        description: description ?? '',
        runtime: runtime ?? 'claude-code',
        capabilities: [],
        // A face at birth, the same as every other creation path (DOR-949).
        // This route mints its own manifest rather than going through
        // `createAgentWorkspace`, so it seeds its own.
        ...seedAgentFace(id),
        behavior: { responseMode: 'always' },
        registeredAt: new Date().toISOString(),
        registeredBy: 'dorkos-ui',
        personaEnabled: true,
        isSystem: false,
        enabledToolGroups: {},
        mcpServers: [],
        workspace: { mode: 'home' },
      };

      await writeManifest(agentPath, manifest);

      // Scaffold convention files with sensible defaults
      const traitBlock = renderTraits(DEFAULT_TRAITS);
      // Display name first, the same order `createAgentWorkspace` uses: SOUL.md
      // opens with "You are <name>", and now that `name` is slugified that has to
      // be the name a person wrote, not `my-custom-agent` (DOR-2054).
      const soulContent = defaultSoulTemplate(manifest.displayName ?? manifest.name, traitBlock);
      const nopeContent = defaultNopeTemplate();

      await writeConventionFile(agentPath, CONVENTION_FILES.soul, soulContent);
      await writeConventionFile(agentPath, CONVENTION_FILES.nope, nopeContent);
      // **Write-if-absent, unlike the two above.** This route registers a
      // directory that may ALREADY have been an agent — a re-register after a
      // rename, a workspace moved and pointed at again — and `MEMORY.md` is the
      // one convention file whose contents the AGENT wrote. SOUL.md and NOPE.md
      // are scaffolds a person edits from a known starting point; notes are not,
      // and overwriting them here would silently delete everything the agent had
      // learned, at a moment nobody associates with data loss.
      if ((await readConventionFile(agentPath, CONVENTION_FILES.memory)) === null) {
        await writeConventionFile(agentPath, CONVENTION_FILES.memory, defaultMemoryTemplate());
      }

      // ADR-0043: sync to Mesh DB cache (best-effort)
      try {
        await meshCore?.syncFromDisk(agentPath);
      } catch {
        /* non-fatal */
      }

      // Fire-and-forget activity event for agent registration
      const activityService = req.app.locals.activityService as ActivityService | undefined;
      if (activityService) {
        await activityService.emit({
          // Ungated, so this genuinely varies: an agent that identified itself is
          // named, and the feed stops crediting the person with a machine's write.
          ...readActivityActor(req, res),
          category: 'agent',
          eventType: 'agent.registered',
          resourceType: 'agent',
          resourceId: manifest.id,
          resourceLabel: manifest.name,
          summary: `Registered agent ${manifest.name}`,
          linkPath: '/agents',
        });
      }

      // The agent-created seam: this register path writes the manifest itself
      // (it does not go through `createAgentWorkspace`), so it must notify the
      // seam directly. Awaited, but never throws — a failing reaction (e.g.
      // Shape schedule re-bind) never turns a successful registration into a 500.
      await notifyAgentCreated({
        id: manifest.id,
        name: manifest.name,
        displayName: manifest.displayName,
        path: agentPath,
        // The New Agent flow: this route minted the manifest and scaffolded
        // SOUL.md/NOPE.md above, and 409s if the directory was already an agent.
        origin: 'created',
      });

      return res.status(201).json(manifest);
    } catch (err) {
      if (err instanceof BoundaryError) {
        return res.status(403).json({ error: err.message, code: err.code });
      }
      logger.error('[agents] POST / failed', { err });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/agents/create
  // Full creation pipeline: mkdir + scaffold + optional template + register
  /**
   * Create the agent a marketplace package brings (DOR-2325), through the
   * installer: one staged copy, validated, held to what the person was shown,
   * and installed where marketplace agents live so updates find it. A person
   * only: an agent installs a marketplace agent with `marketplace_install`,
   * which asks a person.
   */
  const createFromPackage = async (req: Request, res: Response): Promise<Response> => {
    if (req.body.template !== undefined) {
      return res
        .status(400)
        .json({ error: 'Send a template or a package to create the agent from, not both.' });
    }
    if (!trustedCaller(readCallerAuthority(req, res))) {
      return res.status(403).json({
        code: 'operator_only',
        error:
          'Only a person creates an agent from a marketplace package here. An agent installs it ' +
          'with marketplace_install, which asks a person first.',
      });
    }
    const marketplace = deps.marketplace?.();
    if (!marketplace) {
      return res.status(503).json({ error: 'The marketplace is not running on this server.' });
    }
    const pkg = PackageCreationSchema.safeParse(req.body.package);
    const identity = PackageAgentIdentitySchema.safeParse(req.body);
    if (!pkg.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(pkg.error) });
    }
    if (!identity.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(identity.error) });
    }
    // One agent per package: it lives where marketplace agents live, so a
    // second one would replace the first.
    const target = computeTargetDir(
      marketplace.dorkHome,
      { type: 'agent', name: pkg.data.name },
      undefined
    );
    if (await pathExists(target)) {
      return res.status(409).json({
        code: 'COLLISION',
        error: 'This agent is already on your team. Find it there, or remove it first.',
      });
    }
    try {
      const result = await marketplace.installer.install({
        name: pkg.data.name,
        ...(pkg.data.marketplace !== undefined && { marketplace: pkg.data.marketplace }),
        approvedDisclosure: pkg.data.approvedDisclosure,
        approvedContentHash: pkg.data.approvedContentHash,
        agentIdentity: identity.data,
      });
      const manifest = await readManifest(result.installPath);
      if (!manifest) throw new Error('The agent was installed, but its manifest could not be read');
      return res.status(201).json({ ...manifest, _path: result.installPath });
    } catch (err) {
      if (err instanceof DisclosureChangedError) {
        return res.status(409).json({ code: 'disclosure_changed', error: err.message });
      }
      if (err instanceof InvalidPackageError) {
        return res.status(400).json({ error: err.message, errors: err.errors });
      }
      throw err;
    }
  };

  router.post('/create', async (req, res) => {
    try {
      if (req.body?.package !== undefined) return await createFromPackage(req, res);
      const decision = TemplateDecisionSchema.safeParse(req.body ?? {});
      if (!decision.success) {
        return res
          .status(400)
          .json({ error: 'Validation failed', details: z.flattenError(decision.error) });
      }
      // A template is cloned into a staging folder and shown before it lands
      // (DOR-2325): a person is disclosed what it brings; anyone else gets a
      // card. There is no ungated way to create from a template.
      let templateGate: TemplateGate | undefined;
      if (req.body?.template !== undefined) {
        const identity = getRequestAgentIdentity(res);
        templateGate = trustedCaller(readCallerAuthority(req, res))
          ? personTemplateGate(decision.data.approvedTemplateHash)
          : cardTemplateGate({
              provider: deps.confirmationProvider?.(),
              agentName: typeof req.body.name === 'string' ? req.body.name : '',
              directory: landingDirectory(req.body),
              ...(decision.data.confirmationToken && {
                confirmationToken: decision.data.confirmationToken,
              }),
              ...(identity && { requestedBy: identity.displayName || identity.agentPath }),
            });
      }
      // `skipTemplateDownload` is the marketplace install's own switch: it skips
      // the existing-folder check and the template gate, which only the
      // installer's staged copy may do. Never taken from a request.
      const { skipTemplateDownload: _internalOnly, ...options } = req.body ?? {};
      const result = await createAgentWorkspace(
        options,
        meshCore,
        templateGate ? { templateGate } : {}
      );

      // Fire-and-forget activity event for agent registration
      const activityService = req.app.locals.activityService as ActivityService | undefined;
      if (activityService) {
        await activityService.emit({
          // `dorkos agent create` is the busiest caller of this route and runs
          // inside spawned agent sessions, so read the caller rather than assume.
          ...readActivityActor(req, res),
          category: 'agent',
          eventType: 'agent.registered',
          resourceType: 'agent',
          resourceId: result.manifest.id,
          resourceLabel: result.manifest.name,
          summary: `Registered agent ${result.manifest.name}`,
          linkPath: '/agents',
        });
      }

      // (The agent-created seam already fired inside `createAgentWorkspace` —
      // no extra notify here.)
      return res.status(201).json({
        ...result.manifest,
        _path: result.path,
        ...(result.meta ? { _meta: result.meta } : {}),
      });
    } catch (err) {
      if (err instanceof TemplateNeedsReviewError) {
        return res
          .status(409)
          .json({ error: err.message, code: err.code, template: templateOf(err.inspection) });
      }
      if (err instanceof TemplateApprovalPendingError) {
        return res.status(202).json({
          status: err.status,
          confirmationToken: err.token,
          message: err.message,
          template: templateOf(err.inspection),
          ...(err.reason ? { reason: err.reason } : {}),
        });
      }
      if (err instanceof TemplateDeclinedError) {
        return res.status(403).json({ status: 'declined', error: err.message });
      }
      if (err instanceof AgentCreationError) {
        if (err.code === 'VALIDATION') {
          return res.status(400).json({ error: 'Validation failed', details: err.message });
        }
        if (err.code === 'BOUNDARY') {
          return res.status(403).json({ error: err.message, code: 'OUTSIDE_BOUNDARY' });
        }
        return res.status(err.statusCode).json({ error: err.message });
      }
      logger.error('[agents] POST /create failed', { err });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // PATCH /api/agents/current?path=/path/to/project
  // Update agent fields by path
  router.patch('/current', async (req, res) => {
    try {
      const rawPath = req.query.path as string;
      if (!rawPath) {
        return res.status(400).json({ error: 'path query parameter required' });
      }
      const agentPath = await validateBoundaryOrDorkHome(rawPath);

      // Manifest guards + write live in the shared agent-updater service so the
      // `update_agent` MCP tool enforces the exact same rules (ADR-0043 sync
      // included) without re-implementing them.
      const updated = await updateAgentManifest({ agentPath, body: req.body, meshCore });
      return res.json(updated);
    } catch (err) {
      if (err instanceof BoundaryError) {
        return res.status(403).json({ error: err.message, code: err.code });
      }
      if (err instanceof AgentUpdateError) {
        switch (err.code) {
          // `err.message` rather than a fixed string: a refused convention file
          // knows WHICH file and WHY, and that sentence is what the editor puts
          // on screen. A schema failure with nothing better to say still carries
          // "Validation failed", which is what the older tests pin.
          case 'VALIDATION':
            return res.status(400).json({ error: err.message, details: err.details });
          case 'NOT_FOUND':
            return res.status(404).json({ error: err.message });
          case 'SYSTEM_PROTECTED':
          case 'OPERATOR_ONLY':
            return res.status(403).json({ error: err.message });
        }
      }
      logger.error('[agents] PATCH /current failed', { err });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  // POST /api/agents/current/migrate-persona?path=/path/to/project
  // Migrates legacy persona field to SOUL.md convention file
  router.post('/current/migrate-persona', async (req, res) => {
    try {
      const rawPath = req.query.path as string;
      if (!rawPath) {
        return res.status(400).json({ error: 'path query parameter required' });
      }
      const agentPath = await validateBoundaryOrDorkHome(rawPath);

      const manifest = await readManifest(agentPath);
      if (!manifest) {
        return res.status(404).json({ error: 'No agent registered at this path' });
      }

      // Check if already migrated
      const existingSoul = await readConventionFile(agentPath, 'SOUL.md');
      if (existingSoul) {
        return res.json({ migrated: false, reason: 'SOUL.md already exists' });
      }

      const { persona } = manifest as { persona?: string };
      if (!persona) {
        return res.json({ migrated: false, reason: 'No persona to migrate' });
      }

      // Migrate persona text to SOUL.md custom prose
      const traits = (manifest as { traits?: Record<string, number> }).traits;
      const traitBlock = renderTraits({ ...DEFAULT_TRAITS, ...traits });
      const soulContent = buildSoulContent(traitBlock, persona);
      await writeConventionFile(agentPath, 'SOUL.md', soulContent);

      // Scaffold NOPE.md if missing
      const existingNope = await readConventionFile(agentPath, 'NOPE.md');
      if (!existingNope) {
        await writeConventionFile(agentPath, 'NOPE.md', defaultNopeTemplate());
      }

      return res.json({ migrated: true });
    } catch (err) {
      if (err instanceof BoundaryError) {
        return res.status(403).json({ error: err.message, code: err.code });
      }
      logger.error('[agents] POST /current/migrate-persona failed', { err });
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
