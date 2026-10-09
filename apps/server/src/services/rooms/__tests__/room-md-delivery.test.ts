/**
 * `ROOM.md` reaching a room turn (spec `project-rooms` §3.3).
 *
 * Original Room posts enter the real Trigger, Runner, dispatcher and Claude
 * constructor. A pass-through dispatcher observer records DATA only; the
 * external SDK query is scripted, with no private request or producer fabricated:
 *
 * - **A room with no files dispatches exactly what it did before** — the field
 *   is ABSENT, not empty. What the layers below the runner do with the same
 *   promise is pinned in `session/__tests__/message-dispatcher.test.ts`.
 * - **The block is pinned to its turn.** It is composed from a real git repo, so
 *   a merge landing while the turn is in flight is a real merge, and the
 *   assertion is that the dispatch's argument did not move under it.
 * - **The default path is really connected.** The last block leaves the
 *   injection point alone and drives `readRoomConventions` →
 *   `tryGetRoomRepoService` → `RoomRepoService.conventionsFor` over a really
 *   enabled repo.
 *
 * Seeded defects, each run red before the code stood:
 *
 * - Passing `systemPromptAppend: ''` for a non-repo room reddens the zero-change
 *   case.
 * - Re-composing at dispatch time instead of at turn start reddens the pin (on
 *   the compose COUNT — the strings alone would still agree).
 * - Delivering the block on `additionalContext` reddens the seam case.
 * - Returning `null` from the default reader reddens the wiring case.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { promises as fsp, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from '@dorkos/test-utils/supertest';
import { ROOM_REPO_CAP_DEFAULTS, RoomRepoSidecarSchema } from '@dorkos/shared/room-repo';

// Provider-account isolation keeps the SDK double away from real Claude history.
const account = vi.hoisted(() => ({ root: '' }));
vi.mock('../../runtimes/claude-code/claude-config-dir.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../runtimes/claude-code/claude-config-dir.js')>()),
  resolveActiveClaudeRoot: () => account.root,
  resolveLaunchAccountRoot: () => ({ ok: true, root: account.root, accountId: 'default' }),
  resolveClaudeRootSet: () => [account.root],
  claudeConfigDirEnv: (root: string) => ({ CLAUDE_CONFIG_DIR: root }),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  renameSession: vi.fn(),
  forkSession: vi.fn(),
  getSessionInfo: vi.fn().mockResolvedValue(null),
}));

/** Actual dispatcher arguments, observed without replacing its native implementation. */
type TriggerCall = Parameters<
  (typeof import('../../session/message-dispatcher.js'))['dispatchOriginalRoomMessage']
>[2];
const triggered: TriggerCall[] = [];
let duringDispatch: () => Promise<void> = () => Promise.resolve();
const observed: { controller: AbortController; joined: Promise<void>; text: string }[] = [];
vi.mock('../../session/message-dispatcher.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../session/message-dispatcher.js')>();
  const originalDispatch = original.dispatchOriginalRoomMessage;
  return {
    ...original,
    dispatchOriginalRoomMessage: async (
      request: Parameters<typeof originalDispatch>[0],
      runner: Parameters<typeof originalDispatch>[1],
      opts: TriggerCall
    ) => {
      triggered.push(opts);
      const controller = new AbortController();
      const capture = { controller, joined: Promise.resolve(), text: '' };
      capture.joined = (async () => {
        for await (const event of opts.projector.subscribe(
          opts.projector.getCursor(),
          controller.signal
        )) {
          if (event.type === 'text_delta') capture.text += event.text;
          if (event.type === 'turn_end') break;
        }
      })();
      // The owned observer remains joined by teardown even if dispatch refuses.
      void capture.joined.catch(() => undefined);
      observed.push(capture);
      await duringDispatch();
      return originalDispatch(request, runner, opts);
    },
  };
});

const { query } = await import('@anthropic-ai/claude-agent-sdk');
const { ClaudeCodeRuntime } = await import('../../runtimes/claude-code/claude-code-runtime.js');
const { LocalSessionAttachmentStore } =
  await import('../../session/attachments/local-session-attachment-store.js');
const { wrapSdkQuery, sdkSimpleText } =
  await import('../../runtimes/claude-code/__tests__/sdk-scenarios.js');
const configuration = await import('../../core/config-manager.js');
const { runtimeRegistry } = await import('../../core/runtime-registry.js');
const { isTurnInFlight } = await import('../../session/message-dispatcher.js');
const { peekProjector } = await import('../../session/index.js');
const { uiTurnFacts } = await import('../../session/browser-seat/ui-turn-facts.js');
const { createOriginalNativeLaunchFixture } =
  await import('../repo/__tests__/room-original-native-launch-fixture.js');
type OriginalFixture = Awaited<ReturnType<typeof createOriginalNativeLaunchFixture>>;
let original: OriginalFixture | undefined;
let target: Awaited<ReturnType<OriginalFixture['bootNativeAgent']>> | undefined;

async function openNative(
  options: Parameters<typeof createOriginalNativeLaunchFixture>[0] = {}
): Promise<void> {
  original = await createOriginalNativeLaunchFixture({
    seed: false,
    publishRepoService: false,
    roomTitle: 'Release train',
    ...options,
    createNativeRuntime: ({ dir, principals, mesh, targets }) => {
      account.root = path.join(dir, 'claude-account');
      mkdirSync(account.root, { recursive: true });
      vi.mocked(query).mockImplementation(
        (input) =>
          wrapSdkQuery(
            (async function* () {
              const current = targets.find(
                (candidate) => candidate.agentPath === input.options?.cwd
              );
              if (
                !current ||
                uiTurnFacts.read(current.sessionId).roomTurn?.roomId !== original?.roomId
              )
                throw new Error('SDK entered without the original current Room turn');
              yield* sdkSimpleText('ok', current.sessionId);
            })()
          ) as unknown as ReturnType<typeof query>
      );
      const runtime = new ClaudeCodeRuntime(
        dir,
        targets[0]!.agentPath,
        new LocalSessionAttachmentStore(path.join(dir, 'attachments'))
      );
      runtime.setMeshCore(mesh);
      runtime.setConnectorRuntimeTools({
        principals,
        listenerUrl: 'http://127.0.0.1:1/mcp/connections',
        agentToolsUrl: 'http://127.0.0.1:1/mcp/agent-tools',
        isConnectorCapabilityId: () => false,
      });
      return runtime;
    },
  });
  // Real configuration chooses the one-shot provider boundary used in this suite.
  configuration.configManager.set('runtimes', {
    ...configuration.configManager.get('runtimes'),
    claudeCode: {
      ...configuration.configManager.get('runtimes').claudeCode,
      persistentSession: false,
    },
  });
  target = await original.bootNativeAgent();
}

async function send(): Promise<{ text: string }> {
  if (!original || !target) throw new Error('Original native Room is absent');
  const sessionId = target.sessionId;
  const prior = observed.length;
  original.subsystem.service.post(original.roomId, {
    authorId: original.operator.id,
    text: 'is the build green?',
    mentions: [target.authorId],
  });
  await original.subsystem.service.triggersIdle();
  // Native stream retirement precedes final sender/projector retirement.
  // A successor uses the same real session only after both owners are idle.
  await vi.waitFor(() => {
    const selected = runtimeRegistry.get('claude-code');
    expect(isTurnInFlight(sessionId, selected)).toBe(false);
    expect(peekProjector(sessionId)?.getStatus().lifecycle).toBe('idle');
  });
  expect(observed).toHaveLength(prior + 1);
  await observed[prior]!.joined;
  return { text: observed[prior]!.text };
}

async function closeNative(): Promise<void> {
  let failed = false,
    first: unknown;
  const remember = (cause: unknown) => {
    if (!failed) {
      failed = true;
      first = cause;
    }
  };
  // Abort read-only subscribers, start native/provider cancellation, then join both.
  for (const capture of observed) capture.controller.abort();
  const closing = original?.close().catch(remember);
  const results = await Promise.allSettled([closing, ...observed.map((capture) => capture.joined)]);
  for (const result of results) if (result.status === 'rejected') remember(result.reason);
  original = undefined;
  target = undefined;
  observed.length = 0;
  if (failed) throw first;
}

const { RoomConventions } = await import('../repo/room-conventions.js');
const { fixtureGit } = await import('../repo/__tests__/fixture-git.js');
/** Fixture shell state only: these calls do not test or mint a product mutation context. */
async function initRepo(repo: string, ceiling: string): Promise<void> {
  await fixtureGit(
    ['-c', 'init.templateDir=', 'init', '-b', 'main', '--quiet', '.'],
    repo,
    ceiling
  );
}
async function commitAll(
  repo: string,
  message: string,
  identity: { name: string; email: string },
  ceiling: string
): Promise<string> {
  await fixtureGit(['add', '--all'], repo, ceiling);
  await fixtureGit(
    [
      '-c',
      `user.name=${identity.name}`,
      '-c',
      `user.email=${identity.email}`,
      'commit',
      '--no-verify',
      '--quiet',
      '-m',
      message,
    ],
    repo,
    ceiling
  );
  return fixtureGit(['rev-parse', 'HEAD'], repo, ceiling);
}
const { ROOM_MD_FILENAME } = await import('../repo/room-md.js');
const { tryGetRoomRepoService } = await import('../index.js');

const ROOM_ID = '01ROOMAAAAAAAAAAAAAAAAAAAA';
const OPERATOR = { name: 'Dorian', email: 'operator@dorkos.local' };

describe('ROOM.md delivery', () => {
  let scratch: string;
  let home: string;
  let repo: string;
  let hasRepo: boolean;
  let conventions: InstanceType<typeof RoomConventions>;

  /** Write `ROOM.md` and commit it. */
  async function commitRoomMd(body: string): Promise<void> {
    await writeFile(path.join(repo, ROOM_MD_FILENAME), body, 'utf-8');
    await commitAll(repo, 'update the conventions', OPERATOR, home);
  }

  beforeEach(async () => {
    triggered.length = 0;
    observed.length = 0;
    composeCalls = 0;
    duringDispatch = () => Promise.resolve();
    scratch = await mkdtemp(path.join(await fsp.realpath(tmpdir()), 'dorkos-room-md-delivery-'));
    home = path.join(scratch, 'rooms', ROOM_ID);
    repo = path.join(home, 'repo');
    await mkdir(repo, { recursive: true });
    await initRepo(repo, home);
    hasRepo = true;
    conventions = new RoomConventions({
      hasRepo: () => hasRepo,
      repoPath: () => repo,
      homeDir: () => home,
      maxRoomMdBytes: () => ROOM_REPO_CAP_DEFAULTS.maxRoomMdBytes,
    });
  });

  afterEach(async () => {
    await closeNative();
    await rm(scratch, { recursive: true, force: true });
  });

  /** How many times the runner asked the composer, across every turn. */
  let composeCalls = 0;

  /** The original constructor reads the real composer; Trigger issues every request. */
  async function runner(): Promise<void> {
    await openNative({
      roomConventions: (room) => {
        composeCalls += 1;
        return conventions.compose(room);
      },
    });
  }

  it('a room with no files dispatches no append at all', async () => {
    hasRepo = false;
    await commitRoomMd('# Never sent\n');

    await runner();
    await send();

    // Absent, not empty — the seam's own promise, so no consumer downstream has
    // to be careful. `''` happens to be inert today (every adapter guards with a
    // truthiness check), which is exactly why the guarantee is stated here
    // rather than inferred from four coincidences. The layers between this and
    // the runtime are pinned in `session/__tests__/message-dispatcher.test.ts`.
    expect(triggered).toHaveLength(1);
    expect('systemPromptAppend' in triggered[0]!).toBe(false);
  });

  it('sends the conventions on systemPromptAppend, never in the message', async () => {
    await commitRoomMd('# Release train\n\nShip on Thursdays.\n');

    await runner();
    await send();

    const dispatch = triggered[0]!;
    expect(dispatch.systemPromptAppend).toContain('Ship on Thursdays.');
    // `content` is what a person typed, byte for byte — the room's conventions
    // are standing framing, not part of anybody's message (ADR-0273).
    expect(dispatch.content).toBe('is the build green?');
    expect(JSON.stringify(dispatch.roomContext)).not.toContain('Ship on Thursdays');
  });

  it('holds the block for the whole turn — a merge mid-turn changes nothing', async () => {
    await commitRoomMd('# Release train\n\nShip on Thursdays.\n');
    // A real commit landing in the window between the runner handing over its
    // arguments and the turn opening. The next turn must see it; this one
    // must not (the session-snapshot discipline, ADR 260711-142049).
    duringDispatch = async () => {
      await commitRoomMd('# Release train\n\nShip on Mondays now.\n');
    };

    await runner();
    await send();
    duringDispatch = () => Promise.resolve();
    await send();

    expect(triggered).toHaveLength(2);
    expect(triggered[0]!.systemPromptAppend).toContain('Ship on Thursdays.');
    expect(triggered[0]!.systemPromptAppend).not.toContain('Ship on Mondays now.');
    // And the merge is not lost — it lands at the next turn boundary.
    expect(triggered[1]!.systemPromptAppend).toContain('Ship on Mondays now.');
    // ONCE per turn, at its start. This is the half of the pin the strings
    // cannot show: a runner that re-asked mid-turn — per event, or again on the
    // late-answer path — would still produce these two strings while having no
    // pin at all, and would move the block under an agent that had already been
    // told something else.
    expect(composeCalls).toBe(2);
  });

  it('answers the message even when the conventions read itself throws', async () => {
    // A throw out of `run` means NOTHING RAN to the dispatcher, which rewinds
    // the room's read cursor and replays the whole window — so one unreadable
    // cache row would replay somebody's conversation rather than dropping an
    // optional block (room-participation spec §8.3).
    await openNative({ roomConventions: () => Promise.reject(new Error('SQLITE_BUSY')) });
    const result = await send();

    expect(result.text).toBe('ok');
    expect('systemPromptAppend' in triggered[0]!).toBe(false);
  });

  it('goes quiet rather than failing a turn when the room’s files are unreadable', async () => {
    await commitRoomMd('# Release train\n');
    await rm(path.join(repo, '.git'), { recursive: true, force: true });

    await runner();
    const result = await send();

    // The message is still answered. A room whose files cannot be read is a
    // room without files for this turn — never a turn nobody gets an answer to.
    expect(result.text).toBe('ok');
    expect('systemPromptAppend' in triggered[0]!).toBe(false);
  });
});

/**
 * The DEFAULT path — the one production takes.
 *
 * Everything above injects a `roomConventions` reader, which proves the runner's
 * behaviour and nothing about the wiring underneath it. This block leaves that
 * option OFF, so the runner resolves through `readRoomConventions` →
 * `tryGetRoomRepoService()` → `RoomRepoService.conventionsFor` — three seams
 * that had no coverage at all, and any one of which could have been left
 * unconnected with every other test in this file still green.
 *
 * **The two cases are order-dependent, so the first one says so out loud.**
 * `setRoomRepoService` writes module state with no reset, so "no service is
 * registered" is only true before the other case runs. The precondition is
 * asserted rather than assumed: reordered, this fails loudly instead of passing
 * for the wrong reason.
 */
describe('the production wiring', () => {
  let scratch: string;
  let dorkHome: string;

  beforeEach(async () => {
    triggered.length = 0;
    scratch = await mkdtemp(path.join(await fsp.realpath(tmpdir()), 'dorkos-room-md-wiring-'));
    dorkHome = path.join(scratch, '.dork');
    await mkdir(dorkHome, { recursive: true });
  });

  afterEach(async () => {
    await closeNative();
    await rm(scratch, { recursive: true, force: true });
  });

  it('answers without conventions when no repo service is registered', async () => {
    expect(
      tryGetRoomRepoService(),
      'this case must run before anything registers a service; see the block doc'
    ).toBeNull();

    await openNative({ defaultRoomConventions: true });
    const result = await send();

    // The embedded read-only subsystem is the ordinary case: it bootstraps no
    // repo service at all, and every room there is simply a room without files.
    expect(result.text).toBe('ok');
    expect('systemPromptAppend' in triggered[0]!).toBe(false);
  });

  it('reaches ROOM.md through the registered service, with nothing injected', async () => {
    await openNative({ defaultRoomConventions: true, publishRepoService: true });
    if (!original) throw new Error('Original native Room is absent');
    // Real owning HTTP enable, with the original installation owner credential.
    expect(original.repo.hasRepo(original.roomId)).toBe(false);
    const enabled = await request(original.server)
      .post(`/api/rooms/${original.roomId}/repo`)
      .set('Authorization', `Bearer ${original.ownerKey.key}`);
    expect(enabled.status).toBe(201);
    // The public 201 body exposes the created repo sidecar; creation is the native state transition.
    expect(RoomRepoSidecarSchema.safeParse(enabled.body.repo).success).toBe(true);
    expect(enabled.body.repo).toMatchObject({
      roomId: original.roomId,
      createdBy: original.operator.id,
      mode: 'owned',
      defaultBranch: 'main',
    });
    expect(original.repo.hasRepo(original.roomId)).toBe(true);
    const result = await send();

    expect(result.text).toBe('ok');
    const append = triggered[0]!.systemPromptAppend;
    expect(append).toContain('<dorkos_room_conventions room="Release train"');
    // The seeded file's own words, so the assertion cannot pass on framing alone.
    expect(append).toContain('This room has files of its own');
  });
});
