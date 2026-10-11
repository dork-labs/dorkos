import { Router } from 'express';
import path from 'path';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { ulid } from 'ulidx';
import { writeManifest } from '@dorkos/shared/manifest';
import { seedAgentFace } from '@dorkos/shared/agent-face';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { getBoundary } from '../lib/boundary.js';
import { runtimeRegistry } from '../services/core/runtime-registry.js';
import {
  getRoomService,
  getBridgeStore,
  getRoomAuthors,
  resolveOperatorAuthor,
} from '../services/rooms/index.js';
import type { SyncFromDiskResult } from '@dorkos/mesh';

/** Register the original installTestAgentSeedRoutes group on the owned router, in its original order. */
export function installTestAgentSeedRoutes(testControlRouter: Router): void {
  const seedAgentSchema = z
    .object({
      slot: z
        .enum(['shared', 'denied-access', 'permission-requester', 'suggestion-requester'])
        .default('shared'),
      /**
       * A fresh agent in the same slot: a spec whose checks read history that
       * outlives an attempt (the Always allow suggestion counts a week of
       * answers, and "Not now" is kept) seeds a new instance per attempt, so a
       * retry or a rerun on the same server starts clean. Bounded, so the
       * directory stays inside the slot's own by construction.
       */
      instance: z
        .string()
        .regex(/^[a-z0-9-]{1,40}$/)
        .optional(),
    })
    .default({ slot: 'shared' });

  /** A fixed, enum-bounded test identity slot. */
  type SeedAgentSlot = z.infer<typeof seedAgentSchema>['slot'];

  /**
   * Each slot's name and description. The requesters are agents of their own so
   * the permission specs' changes, their per-agent request limits and the
   * Always allow suggestion's count never touch DorkBot or each other.
   */
  const SEED_AGENT_COPY: Record<SeedAgentSlot, { name: string; description: string }> = {
    shared: {
      name: 'E2E Test Agent',
      description: 'Seeded by test setup — runs on the server default runtime',
    },
    'denied-access': {
      name: 'E2E Denied Agent',
      description: 'Requests access that the owner denies.',
    },
    'permission-requester': {
      name: 'E2E Permission Requester',
      description: 'Asks for permissions a person answers on the request card.',
    },
    'suggestion-requester': {
      name: 'E2E Suggestion Requester',
      description: 'Asks for the same thing until the card suggests Always allow.',
    },
  };

  /**
   * Fixture directory for a seeded test agent, derived from the RESOLVED
   * directory boundary and a closed slot enum so it is in-bounds by construction.
   *
   * It used to be spelled `os.homedir()/tmp/dorkos-e2e-agent`, which was in-bounds
   * only by coincidence: an unconfigured boundary happens to default to the home
   * directory. Under a configured `DORKOS_BOUNDARY` (the Docker deployment) that
   * seeded an agent outside the boundary, which every cockpit surface would then
   * refuse — and it reached into the operator's real home to do it, which
   * `os.homedir()` is banned in server code for (Hard Rule 3).
   *
   * `getBoundary()` returns a realpath-resolved root, so the path handed back is
   * already canonical — the same form `validateBoundary()` normalizes to before
   * it checks containment. Under an unconfigured boundary that need not be the
   * literal `~/...` string the old constant produced (a symlinked home resolves
   * through), but it names the same directory and is the more robust of the two.
   *
   * Resolved per request rather than at module load: `app.ts` imports this router
   * statically, which runs before `initBoundary()` does at startup.
   */
  function e2eAgentDir(slot: SeedAgentSlot = 'shared', instance?: string): string {
    const suffix = `${slot === 'shared' ? '' : `-${slot}`}${instance ? `-${instance}` : ''}`;
    return path.join(getBoundary(), 'tmp', `dorkos-e2e-agent${suffix}`);
  }

  /**
   * The fixture agent's identity, derived from its directory rather than minted.
   *
   * **Why this is not `ulid()` (DOR-1142 review).** `chat-mock.spec.ts` seeds in
   * a per-test `beforeEach`, so a fresh id per call meant a fresh identity for the
   * same directory dozens of times per run — and `AgentRegistry.upsert` handles a
   * new id at an occupied path by DELETING the incumbent row. That delete is
   * `registry.remove()`, a bare row delete, not `unregister()` — so it never
   * reaches `relayBridge.unregisterAgent`, while `upsertAutoImported` goes on to
   * register a Relay endpoint for the new id. One orphaned endpoint per seed, on
   * a leg that runs with Relay enabled. The rooms author-registry reads the same
   * churn as an occupancy change: it keys rows to `minted_for_manifest_id`, so a
   * new id at a known directory is "this directory changed hands" and the rooms
   * do not carry over.
   *
   * Nothing failed today, which is exactly why it is worth pinning: the fixture
   * was quietly exercising the relocation machinery on every test instead of
   * being the boring, stable agent it is meant to stand for.
   *
   * Keyed on the PATH rather than a bare constant so the mapping stays one-to-one
   * in both directions. A constant would follow the fixture to whatever directory
   * a changed `DORKOS_BOUNDARY` puts it in, and against a `DORK_HOME` that
   * outlived the move the old row would still hold that id at the old path —
   * which `upsert` answers with `duplicate-id`, i.e. the seed route failing for a
   * reason no diff explains. Same directory, same agent; different directory,
   * different agent.
   *
   * Shaped like a ULID (26 Crockford-base32 characters) because that is what the
   * rest of the system reads ids as, though nothing validates the format —
   * `AgentManifestSchema.id` is `z.string().min(1)`. The digest is truncated, not
   * decoded: this needs to be stable and collision-free against one other
   * fixture, not unguessable.
   *
   * @param agentDir - The fixture's directory, from {@link e2eAgentDir}.
   */
  function fixtureAgentId(agentDir: string): string {
    const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    const digest = createHash('sha256').update(agentDir).digest();
    let id = '';
    for (let i = 0; i < 26; i += 1) id += CROCKFORD[digest[i] % 32];
    return id;
  }

  /**
   * The execution runtime the shared fixture agent's manifest declares.
   *
   * `AgentManifest.runtime` is required and its enum has no `test-mode` member,
   * so this fixture has to name a real harness — and a manifest runtime WINS over
   * the server default whenever this process registers it
   * (`resolveRuntimeTypeForNewSession` in
   * `services/session/launch/launch-session.ts`). Every spec that
   * starts a session in this agent's directory means "the server default"
   * (`test-mode`), so the declared value must be a runtime the test-mode server
   * never registers — then resolution soft-falls back to the default.
   *
   * It used to say `claude-code`, which held only for as long as nothing
   * registered that type here. DOR-952 registered a claude-code-typed
   * TestModeRuntime alias so the managed-MCP OAuth spec could resolve
   * `GET /api/mcp-config?runtime=claude-code`, and every seeded session silently
   * moved onto that alias: session rows started reading "Claude Code" instead of
   * "Test Mode" and the session-list runtime-mark spec failed on every run
   * (DOR-991). `codex` is a real runtime this server never registers — and the
   * guard below turns a future alias for it into a named failure instead of the
   * same silent re-pointing.
   */
  const FIXTURE_AGENT_RUNTIME = 'codex';

  /**
   * Seed a test agent in one of four fixed slots inside the directory boundary —
   * on disk AND in the mesh registry.
   *
   * Overwrites any existing manifest so tests always start with a clean agent.
   * Returns `{ agentDir, agentId }` so the test can navigate to `/?dir=<agentDir>`.
   *
   * **Registration is half the job, and it used to be missing (DOR-1142).** This
   * route wrote a manifest and stopped, which is not the same as having an agent:
   * `GET /api/sessions/recent` and `GET /api/sessions/daily-counts` both fan out
   * over `meshCore.listWithPaths()`, so a directory the mesh has never heard of
   * contributes no sessions however many it holds. Every sidebar zone that is
   * built from recent sessions — Today, Heads-up — was therefore structurally
   * empty on the test-mode leg, and three separate suites had grown their own
   * `beforeEach`/`afterEach` registration dance to work around it. Seeding an
   * agent nothing can see is a seam with a hole in it, not a fixture.
   *
   * **`syncFromDisk`, deliberately, and not `registerByPath`.** The suites'
   * workaround called `POST /api/mesh/agents`, which does more than register: it
   * used to mint a SECOND id distinct from the manifest's own and rewrite the
   * manifest it was just handed (that half is gone — since DOR-1019 it adopts a
   * manifest already on disk), and it still fires
   * `notifyAgentCreated` — whose reaction seats the agent in #team. On a server
   * the `chromium-team-room` project also drives, that is a cross-project side
   * effect nobody asked for. `syncFromDisk` is the same path `POST /api/agents`
   * uses for a manifest already written by hand: it adopts the id on disk, adds
   * exactly one registry row, and announces nothing.
   *
   * **No cleanup is owed, because little accumulates.** Each of the four slots maps
   * to one fixed directory and stable id; an `instance` adds one agent per
   * attempt, inside the leg's throwaway data directory. Re-seeding replaces that slot's row
   * rather than stacking rows. `POST /api/test/reset` does not touch mesh, and
   * does not need to.
   *
   * Refuses when {@link FIXTURE_AGENT_RUNTIME} is registered here — see there.
   */
  testControlRouter.post('/seed-agent', async (req, res) => {
    const input = seedAgentSchema.safeParse(req.body);
    if (!input.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(input.error) });
    }
    if (runtimeRegistry.has(FIXTURE_AGENT_RUNTIME)) {
      return res.status(500).json({
        error:
          `seed-agent: '${FIXTURE_AGENT_RUNTIME}' is registered on this server, so sessions ` +
          `seeded from this agent would bind to it instead of the server default ` +
          `('${runtimeRegistry.getDefaultType()}'). Point FIXTURE_AGENT_RUNTIME at a runtime ` +
          `this server does not register.`,
      });
    }
    const { slot, instance } = input.data;
    const agentDir = e2eAgentDir(slot, instance);
    const fixtureId = fixtureAgentId(agentDir);
    const manifest: AgentManifest = {
      id: fixtureId,
      ...SEED_AGENT_COPY[slot],
      runtime: FIXTURE_AGENT_RUNTIME,
      capabilities: [],
      // A fixture agent wears a face for the same reason a real one does: no
      // production path can mint a faceless agent any more (DOR-949), so a
      // browser test staged against one would be testing a shape the app cannot
      // produce. Deterministic from the fixture's own id, like everywhere else.
      ...seedAgentFace(fixtureId),
      behavior: { responseMode: 'always' },
      registeredAt: new Date().toISOString(),
      registeredBy: 'dorkos-e2e',
      personaEnabled: false,
      isSystem: false,
      mcpServers: [],
      workspace: { mode: 'home' },
    };
    await writeManifest(agentDir, manifest);

    // Every refusal below is a 500 rather than a quiet `{ ok: true }`. A seed
    // route that half-worked is what this ticket was: the caller gets a
    // directory, believes it has an agent, and fails ten assertions later in a
    // spec about the sidebar. Say it here, where the cause is.
    //
    // Deliberately NOT the best-effort `try { ... } catch { /* non-fatal */ }`
    // that `POST /api/agents` wraps its own `syncFromDisk` in. There, swallowing
    // is right: the agent was really created and the DB cache reconciles itself
    // within five minutes. Here, registration IS the product of the call, so a
    // swallowed throw would hand back the same `{ ok: true }` as a working seed
    // and put the hole straight back.
    const meshCore = req.app.locals.meshCore as
      { syncFromDisk(path: string): Promise<SyncFromDiskResult> } | undefined;
    if (!meshCore) {
      return res.status(500).json({
        error:
          'seed-agent: this server has no meshCore, so the seeded agent cannot be registered. ' +
          'Sessions in it would be invisible to GET /api/sessions/recent.',
      });
    }
    // The catch is what keeps a thrown registration legible. Express 5 would
    // forward a rejected handler promise to the generic error handler on its
    // own, which answers 500 with no mention of seeding — a diagnosis-free 500
    // in the one route whose entire job is diagnosis.
    let outcome: SyncFromDiskResult;
    try {
      outcome = await meshCore.syncFromDisk(agentDir);
    } catch (err) {
      return res.status(500).json({
        error:
          `seed-agent: wrote the manifest at ${agentDir} but mesh registration threw: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      });
    }
    if (outcome !== 'synced') {
      return res.status(500).json({
        error:
          `seed-agent: wrote the manifest but the mesh refused it (${outcome}). ` +
          `'no-manifest' means \`readManifest\` answered null for ${agentDir} — the write did ` +
          `not land, or the file is unreadable, or it no longer satisfies AgentManifestSchema. ` +
          `'duplicate-id' means another directory holds id ${manifest.id}; since that id is ` +
          `derived from this path, it means a stale row survives from when the fixture lived ` +
          `elsewhere — wipe this server's DORK_HOME.`,
      });
    }
    res.json({ ok: true, agentDir, agentId: manifest.id });
  });

  const seedBridgeSchema = z.object({
    /** The bound agent's directory, from `POST /api/test/seed-agent`. */
    agentPath: z.string().min(1),
  });

  /**
   * Seed a bridged **channel** — the platform faked one layer up, at the adapter
   * boundary, so there is no grammY `Bot` and no live Telegram (the same fake the
   * server-side integration suite uses). It mints the room and its `room_bridges`
   * row through the real `RoomService.createBridgedRoom`, stamps a
   * `mentions-only` visibility so the header badge renders, and writes one
   * external-author entry through the real `postExternal` so an origin mark
   * renders beside a message from outside the machine. The e2e (`tests/relay/
   * bridged-channel.spec.ts`) then drives the cockpit-observable half: see the
   * badge and the mark, post from the composer, watch the post land.
   *
   * Only reachable under `DORKOS_TEST_RUNTIME` (this whole router is), and it
   * uses a fresh chat id per call so re-runs never collide on the bridge's
   * `(adapterId, chatId)` unique index.
   */
  testControlRouter.post('/seed-bridge', async (req, res) => {
    const result = seedBridgeSchema.safeParse(req.body);
    if (!result.success) {
      return res
        .status(400)
        .json({ error: 'Validation failed', details: z.flattenError(result.error) });
    }
    try {
      // Register the seeded agent into the mesh cache so the room roster can
      // resolve it by path (ADR-0043's file-first write-through).
      //
      // Redundant for the usual caller and kept anyway. `seed-agent` registers
      // what it seeds now (DOR-1142), so a bridge seeded against that fixture is
      // already resolvable and this is a no-op re-sync — `upsert` on an unchanged
      // manifest. But `agentPath` is a free parameter: nothing makes a caller
      // pass the fixture's directory, and a spec that writes its own manifest
      // somewhere and bridges it would otherwise get a roster that cannot name
      // the agent. Costing one idempotent write to stay correct for any path is
      // the right trade for a test seam.
      const meshCore = req.app.locals.meshCore as
        { syncFromDisk(path: string): Promise<unknown> } | undefined;
      if (meshCore) await meshCore.syncFromDisk(result.data.agentPath);

      const rooms = getRoomService();
      const bridges = getBridgeStore();
      // The operator is the install owner when there is one (onboarding creates
      // it), and the unbound local human otherwise — the same resolution the
      // production bridge lifecycle uses, so `createBridgedRoom`'s owner check
      // passes on a real (onboarded) server the same way it does in prod.
      const authors = getRoomAuthors();
      const operatorAuthorId = resolveOperatorAuthor(authors).id;
      const adapterId = 'tg-e2e';
      const chatId = ulid();

      const opened = rooms.createBridgedRoom({
        adapterId,
        chatId,
        bindingId: `bind-e2e-${chatId}`,
        chatType: 'group',
        channelType: 'group',
        title: 'E2E Ops Channel',
        agentPath: result.data.agentPath,
        operatorAuthorId,
      });

      // §8: the header badge reads the bridge row's visibility, sourced from the
      // platform's `getMe` in production — stamped directly here.
      bridges.setVisibility(opened.id, 'mentions-only', new Date().toISOString());

      // One message from outside the machine, so an origin mark ("· Telegram")
      // renders. `postExternal` mints the external author on the `platform:` key
      // that carries the origin (spec §4.3).
      rooms.postExternal(opened.id, {
        identity: {
          platformType: 'telegram',
          instanceId: adapterId,
          platformUserId: '145223',
          displayName: 'Miguel',
        },
        text: 'Hi from Telegram — can the team see this?',
      });

      res.json({ ok: true, roomId: opened.id, slug: opened.slug, chatId });
    } catch (err) {
      return res
        .status(500)
        .json({ error: err instanceof Error ? err.message : 'seed-bridge failed' });
    }
  });
}
