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
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
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
import { seedHeartbeatFile } from '../services/heartbeats/heartbeat-file.js';
import { defaultMemoryTemplate } from '@dorkos/memory';
import { renderTraits, DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import { validateBoundaryOrDorkHome, BoundaryError } from '../lib/boundary.js';
import { createAgentWorkspace, AgentCreationError } from '../services/core/agent-creator.js';
import { updateAgentManifest, AgentUpdateError } from '../services/core/operator/agent-updater.js';
import { creditsAgentModelRefusal } from '../services/core/cloud/credits-model-gate.js';
import {
  refuseAgentExecutionWrites,
  refuseAgentSelfFilesFromWifi,
} from '../middleware/agent-execution-gate.js';
import { notifyAgentCreated } from '../services/core/agent-created-hook.js';
import { resolveNamedAgentIdentity } from '../services/mesh/normalize-agent-identity.js';
import { logger } from '../lib/logger.js';
import {
  homeOf,
  readHomeManifest,
  resolveAgentHome,
} from '../services/core/agent-identity/index.js';
import type { ActivityService } from '../services/activity/activity-service.js';
import { readActivityActor } from '../services/activity/activity-actor.js';
import type { SyncFromDiskResult } from '@dorkos/mesh';
import { trustedCaller } from '../services/core/capabilities/index.js';
import { clearsTheAgentBar, readCallerAuthority } from '../lib/caller-authority.js';
import { pinPersonCreatedAgent } from '../services/runtimes/claude-code/folder-settings/folder-config-consent.js';
import type { ApiEnv } from '../http/api-chain.js';
import { readJsonBody } from '../http/request-body.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { readQuery } from '../http/request-query.js';
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
import { DisclosedEffectsSchema } from '../services/marketplace/preview/disclosed-effects.js';
import { computeTargetDir } from '../services/marketplace/flows/install-agent.js';
import { templateFromTrustedSource } from '../services/core/agent-templates/trusted-template-source.js';
import { type MarketplaceInstaller } from '../services/marketplace/installer/marketplace-installer.js';
import {
  DisclosureChangedError,
  InvalidPackageError,
} from '../services/marketplace/installer/errors.js';
import { CreateAgentOptionsSchema } from '@dorkos/shared/mesh-schemas';
import { PackageNameSchema } from '@dorkos/marketplace';
import { creatorField } from '../services/heartbeats/reports-to.js';

/** Minimal MeshCore interface for sync-on-write. */
interface MeshCoreLike {
  syncFromDisk(projectPath: string): Promise<SyncFromDiskResult>;
}

/**
 * What agent creation reads from services composed later in boot (DOR-2325).
 * Read lazily, per request: the marketplace's confirmation provider is built
 * after these routes are handed over.
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

/** What the agent identity routes read. */
export interface AgentsRouterDeps extends AgentCreationDeps {
  /** The registry, for DB sync after writes; absent when the mesh did not start. */
  meshCore?: MeshCoreLike;
  /** Where a registration is recorded; absent in a test that does not watch it. */
  activity?: ActivityService;
}

/** The path query parameter, as Express read it: a repeated key is an array. */
function rawPathOf(c: Context<ApiEnv>): string {
  return readQuery(c).path as string;
}

/**
 * Create the agent identity routes.
 *
 * @param deps - The registry, the activity feed, and what creation reads lazily
 * @returns The routes, to mount at `/api/agents`.
 */
export function createAgentsRoutes(deps: AgentsRouterDeps = {}): Hono<ApiEnv> {
  const { meshCore, activity: activityService } = deps;
  const router = new Hono<ApiEnv>();

  // GET /api/agents/current?path=/path/to/project
  // Returns the agent manifest for the home the given directory resolves to,
  // or null when no agent lives there. A worktree or managed checkout of an
  // agent's repo answers with the agent's HOME values, never the committed
  // `.dork/` copy it carries (spec `agent-home-desk` §3.2 row 9).
  router.get('/current', async (c) => {
    try {
      const rawPath = rawPathOf(c);
      if (!rawPath) {
        return c.json({ error: 'path query parameter required' }, 400);
      }
      const agentPath = homeOf(resolveAgentHome(await validateBoundaryOrDorkHome(rawPath)));
      if (!agentPath) {
        return c.json(null);
      }
      const manifest = await readHomeManifest(agentPath);
      if (!manifest) {
        return c.json(null);
      }

      // Include convention file contents alongside manifest data
      const soulContent = await readConventionFile(agentPath, CONVENTION_FILES.soul);
      const nopeContent = await readConventionFile(agentPath, CONVENTION_FILES.nope);
      // Read alongside the other two, so the editor that PATCHes `memoryContent`
      // can read back what it saved. Without this the round trip is broken in
      // the direction a person notices last: the save appears to work and the
      // field comes back empty on the next load.
      const memoryContent = await readConventionFile(agentPath, CONVENTION_FILES.memory);
      // Read for the Heartbeat page's editor, for the same round-trip reason.
      const heartbeatContent = await readConventionFile(agentPath, CONVENTION_FILES.heartbeat);

      return c.json({ ...manifest, soulContent, nopeContent, memoryContent, heartbeatContent });
    } catch (err) {
      if (err instanceof BoundaryError) {
        return c.json({ error: err.message, code: err.code }, 403);
      }
      logger.error('[agents] GET /current failed', { err });
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // POST /api/agents/resolve
  // Batch resolve agents for multiple paths (avoids N+1 in DirectoryPicker)
  router.post('/resolve', async (c) => {
    try {
      const result = ResolveAgentsRequestSchema.safeParse(readJsonBody(c));
      if (!result.success) {
        return c.json({ error: 'Validation failed', details: z.flattenError(result.error) }, 400);
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
      return c.json({ agents });
    } catch (err) {
      logger.error('[agents] POST /resolve failed', { err });
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // POST /api/agents
  // Create a new agent (writes .dork/agent.json)
  router.post('/', async (c) => {
    try {
      const result = CreateAgentRequestSchema.safeParse(readJsonBody(c));
      if (!result.success) {
        return c.json({ error: 'Validation failed', details: z.flattenError(result.error) }, 400);
      }
      const { path: rawAgentPath, name, displayName, description, runtime } = result.data;
      const agentPath = await validateBoundaryOrDorkHome(rawAgentPath);

      // Check if agent already exists
      const existing = await readManifest(agentPath);
      if (existing) {
        return c.json({ error: 'Agent already exists at this path', agent: existing }, 409);
      }

      // The same identity gate the mesh register route and the `mesh_register`
      // tool use. Two bugs here, both DOR-2054: `displayName` was accepted by
      // the request schema and then dropped on the floor, and `name` was written
      // through unslugified, so a person naming an agent "My Bot" from this
      // route got that string as the immutable slug an `@handle` derives from.
      const identity = resolveNamedAgentIdentity({ name, displayName }, path.basename(agentPath));
      if (!identity.ok) {
        return c.json({ error: identity.error, code: identity.code }, 400);
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
        // The account making this request (spec `heartbeats` §4.1).
        ...creatorField(),
        personaEnabled: true,
        isSystem: false,
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
      // HEARTBEAT.md by runtime (spec `heartbeats` §2), write-if-absent for the
      // reason MEMORY.md is: a re-registered agent's own file is its own.
      await seedHeartbeatFile(agentPath, { runtime: manifest.runtime });
      // A person's new agent runs on the runtime they picked (DOR-3459).
      if (clearsTheAgentBar(honoRequestFacts(c))) pinPersonCreatedAgent(manifest.id, agentPath);

      // ADR-0043: sync to Mesh DB cache (best-effort)
      try {
        await meshCore?.syncFromDisk(agentPath);
      } catch {
        /* non-fatal */
      }

      // Fire-and-forget activity event for agent registration
      if (activityService) {
        await activityService.emit({
          // Ungated, so this genuinely varies: an agent that identified itself is
          // named, and the feed stops crediting the person with a machine's write.
          ...readActivityActor(honoRequestFacts(c)),
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

      return c.json(manifest, 201);
    } catch (err) {
      if (err instanceof BoundaryError) {
        return c.json({ error: err.message, code: err.code }, 403);
      }
      logger.error('[agents] POST / failed', { err });
      return c.json({ error: 'Internal server error' }, 500);
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
  const createFromPackage = async (
    c: Context<ApiEnv>,
    body: Record<string, unknown>
  ): Promise<Response> => {
    if (body.template !== undefined) {
      return c.json(
        { error: 'Send a template or a package to create the agent from, not both.' },
        400
      );
    }
    if (!trustedCaller(readCallerAuthority(honoRequestFacts(c)))) {
      return c.json(
        {
          code: 'operator_only',
          error:
            'Only a person creates an agent from a marketplace package here. An agent installs it ' +
            'with marketplace_install, which asks a person first.',
        },
        403
      );
    }
    const marketplace = deps.marketplace?.();
    if (!marketplace) {
      return c.json({ error: 'The marketplace is not running on this server.' }, 503);
    }
    const pkg = PackageCreationSchema.safeParse(body.package);
    const identity = PackageAgentIdentitySchema.safeParse(body);
    if (!pkg.success) {
      return c.json({ error: 'Validation failed', details: z.flattenError(pkg.error) }, 400);
    }
    if (!identity.success) {
      return c.json({ error: 'Validation failed', details: z.flattenError(identity.error) }, 400);
    }
    // One agent per package: it lives where marketplace agents live, so a
    // second one would replace the first.
    const target = computeTargetDir(
      marketplace.dorkHome,
      { type: 'agent', name: pkg.data.name },
      undefined
    );
    if (await pathExists(target)) {
      return c.json(
        {
          code: 'COLLISION',
          error: 'This agent is already on your team. Find it there, or remove it first.',
        },
        409
      );
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
      return c.json({ ...manifest, _path: result.installPath }, 201);
    } catch (err) {
      if (err instanceof DisclosureChangedError) {
        return c.json({ code: 'disclosure_changed', error: err.message }, 409);
      }
      if (err instanceof InvalidPackageError) {
        return c.json({ error: err.message, errors: err.errors }, 400);
      }
      throw err;
    }
  };

  router.post('/create', async (c) => {
    try {
      const body = readJsonBody(c) as Record<string, unknown> | undefined;
      if (body?.package !== undefined) return await createFromPackage(c, body);
      const decision = TemplateDecisionSchema.safeParse(body ?? {});
      if (!decision.success) {
        return c.json({ error: 'Validation failed', details: z.flattenError(decision.error) }, 400);
      }
      // A template is cloned into a staging folder and shown before it lands
      // (DOR-2325): a person is disclosed what it brings; anyone else gets a
      // card, unless it is a built-in template that brings nothing that runs
      // on its own and the install is Trusted (spec `trusted-by-default-flip`
      // §5.10). There is no ungated way to create from a template.
      let templateGate: TemplateGate | undefined;
      if (body?.template !== undefined) {
        const facts = honoRequestFacts(c);
        const identity = facts.agentIdentity;
        templateGate = trustedCaller(readCallerAuthority(facts))
          ? personTemplateGate(decision.data.approvedTemplateHash)
          : cardTemplateGate({
              provider: deps.confirmationProvider?.(),
              agentName: typeof body.name === 'string' ? body.name : '',
              directory: landingDirectory(body),
              ...(decision.data.confirmationToken && {
                confirmationToken: decision.data.confirmationToken,
              }),
              ...(identity && { requestedBy: identity.displayName || identity.agentPath }),
              trustedSource: await templateFromTrustedSource(body.template, identity),
            });
      }
      // `skipTemplateDownload` is the marketplace install's own switch: it skips
      // the existing-folder check and the template gate, which only the
      // installer's staged copy may do. Never taken from a request.
      const { skipTemplateDownload: _internalOnly, ...options } = body ?? {};
      // A new agent that will run on DorkOS credits names a model credits serve
      // (DOR-2636). Nobody has allowed it onto credits yet, so only credits as
      // the machine default can put it there.
      if (typeof options.model === 'string') {
        const refusal = await creditsAgentModelRefusal({
          agentId: undefined,
          runtime: typeof options.runtime === 'string' ? options.runtime : undefined,
          account: typeof options.account === 'string' ? options.account : null,
          model: options.model,
          accountNamedNow: false,
        });
        if (refusal) return c.json({ error: refusal, code: 'UNSUPPORTED_MODEL' }, 400);
      }
      const result = await createAgentWorkspace(
        options,
        meshCore,
        templateGate ? { templateGate } : {}
      );
      // A person's new agent runs on the runtime they picked; an agent's new
      // agent waits for a person's card (DOR-3459).
      if (clearsTheAgentBar(honoRequestFacts(c))) {
        pinPersonCreatedAgent(result.manifest.id, result.path);
      }

      // Fire-and-forget activity event for agent registration
      if (activityService) {
        await activityService.emit({
          // `dorkos agent create` is the busiest caller of this route and runs
          // inside spawned agent sessions, so read the caller rather than assume.
          ...readActivityActor(honoRequestFacts(c)),
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
      return c.json(
        {
          ...result.manifest,
          _path: result.path,
          ...(result.meta ? { _meta: result.meta } : {}),
        },
        201
      );
    } catch (err) {
      if (err instanceof TemplateNeedsReviewError) {
        return c.json(
          { error: err.message, code: err.code, template: templateOf(err.inspection) },
          409
        );
      }
      if (err instanceof TemplateApprovalPendingError) {
        return c.json(
          {
            status: err.status,
            confirmationToken: err.token,
            message: err.message,
            template: templateOf(err.inspection),
            ...(err.reason ? { reason: err.reason } : {}),
          },
          202
        );
      }
      if (err instanceof TemplateDeclinedError) {
        return c.json({ status: 'declined', error: err.message }, 403);
      }
      if (err instanceof AgentCreationError) {
        if (err.code === 'VALIDATION') {
          return c.json({ error: 'Validation failed', details: err.message }, 400);
        }
        if (err.code === 'BOUNDARY') {
          return c.json({ error: err.message, code: 'OUTSIDE_BOUNDARY' }, 403);
        }
        return c.json({ error: err.message }, err.statusCode as ContentfulStatusCode);
      }
      logger.error('[agents] POST /create failed', { err });
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // PATCH /api/agents/current?path=/path/to/project
  // Update agent fields by path
  // An agent's runtime, model and effort move every schedule that follows it,
  // so an agent changing them is sent to the tool that asks a person (DOR-2328).
  router.patch('/current', refuseAgentExecutionWrites, refuseAgentSelfFilesFromWifi, async (c) => {
    try {
      const rawPath = rawPathOf(c);
      if (!rawPath) {
        return c.json({ error: 'path query parameter required' }, 400);
      }
      // Written to the home the path resolves to — the same one GET answered
      // from — so an editor opened on a worktree or checkout changes the agent,
      // never the branch's committed copy (spec `agent-home-desk` §3.2 row 9).
      const agentPath = homeOf(resolveAgentHome(await validateBoundaryOrDorkHome(rawPath)));
      if (!agentPath) {
        return c.json({ error: 'No agent registered at this path' }, 404);
      }

      // Manifest guards + write live in the shared agent-updater service so the
      // `update_agent` MCP tool enforces the exact same rules (ADR-0043 sync
      // included) without re-implementing them.
      const updated = await updateAgentManifest({ agentPath, body: readJsonBody(c), meshCore });
      return c.json(updated);
    } catch (err) {
      if (err instanceof BoundaryError) {
        return c.json({ error: err.message, code: err.code }, 403);
      }
      if (err instanceof AgentUpdateError) {
        switch (err.code) {
          // `err.message` rather than a fixed string: a refused convention file
          // knows WHICH file and WHY, and that sentence is what the editor puts
          // on screen. A schema failure with nothing better to say still carries
          // "Validation failed", which is what the older tests pin.
          case 'VALIDATION':
            return c.json({ error: err.message, details: err.details }, 400);
          case 'NOT_FOUND':
            return c.json({ error: err.message }, 404);
          case 'SYSTEM_PROTECTED':
          case 'OPERATOR_ONLY':
            return c.json({ error: err.message }, 403);
          case 'UNSUPPORTED_MODEL':
          case 'REPORTS_TO_CYCLE':
            return c.json({ error: err.message, code: err.code }, 400);
        }
      }
      logger.error('[agents] PATCH /current failed', { err });
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  // POST /api/agents/current/migrate-persona?path=/path/to/project
  // Migrates legacy persona field to SOUL.md convention file
  router.post('/current/migrate-persona', async (c) => {
    try {
      const rawPath = rawPathOf(c);
      if (!rawPath) {
        return c.json({ error: 'path query parameter required' }, 400);
      }
      const agentPath = homeOf(resolveAgentHome(await validateBoundaryOrDorkHome(rawPath)));
      const manifest = agentPath ? await readHomeManifest(agentPath) : null;
      if (!agentPath || !manifest) {
        return c.json({ error: 'No agent registered at this path' }, 404);
      }

      // Check if already migrated
      const existingSoul = await readConventionFile(agentPath, 'SOUL.md');
      if (existingSoul) {
        return c.json({ migrated: false, reason: 'SOUL.md already exists' });
      }

      const { persona } = manifest as { persona?: string };
      if (!persona) {
        return c.json({ migrated: false, reason: 'No persona to migrate' });
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

      return c.json({ migrated: true });
    } catch (err) {
      if (err instanceof BoundaryError) {
        return c.json({ error: err.message, code: err.code }, 403);
      }
      logger.error('[agents] POST /current/migrate-persona failed', { err });
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  return router;
}
