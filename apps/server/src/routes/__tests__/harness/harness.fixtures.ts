/**
 * Shared setup for the `/api/harness` route tests: the REAL router, the REAL
 * boundary module and real `mkdtemp` trees, because every claim in them is about
 * a seam: what the validator resolves, what the status model then reads, and
 * what is left on disk afterwards. A mocked filesystem or validator would let the
 * fixture and the route agree with each other while both were wrong, which is
 * exactly how DOR-678 shipped.
 *
 * The router takes its hook-decision reader as a dependency, and these suites
 * pass {@link harnessState}'s. The pieces that need login on or the shipped
 * decisions reader (`harness.sync.test.ts`) stub the config store and the session
 * gate from that same state; the others open a real config store in a folder of
 * its own, so the dork-home snapshot still proves nothing is written there.
 *
 * Every case names the seeded defect that reds it.
 *
 * @module routes/__tests__/harness/harness.fixtures
 */
import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { RequestListener, Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import request, { type Response as TestResponse } from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { initBoundary } from '../../../lib/boundary.js';
import type {
  ApprovalBinding,
  ApprovalConsumeResult,
  ApprovalRequestInput,
  ApprovalTicket,
} from '../../../services/core/approvals/approval-service.js';
import { hookApprovalEntry, type HookDecisions } from '../../../services/harness/hook-consent.js';
import { scanHookRequests } from '../../../services/harness/project-with-consent.js';
import { createHarnessRoutes } from '../../harness.js';
import { honoGroupListener } from '../../../http/__tests__/hono-group-listener.js';
import { _internal as askInternal } from '../../../services/harness/ask-withheld-hooks.js';

/** Nobody has decided anything: the shape every case runs under unless it says. */
export const NO_DECISIONS: HookDecisions = { approved: [], refused: [] };

/** A diff naming nothing: what a read is allowed to leave behind. */
export const NO_CHANGES = { added: [], changed: [], removed: [] };

/**
 * The message a broken dependency carries, with a path in it on purpose: finding
 * any of it in a 500's body is unambiguous.
 */
export const READ_FAILURE = new Error(
  'config store unreadable at /Users/someone/private-notes/.dork'
);

/** What a case may change, reset after every case so one test's yes is never another's. */
export const harnessState = {
  /** The decisions the router reads. */
  hookDecisions: NO_DECISIONS as HookDecisions,
  /** Whether DorkOS login is on (only the stubbed-config piece can turn it on). */
  loginEnabled: false,
  /** The stored permission preset the shipped decisions reader sees. */
  storedPreset: 'trusted',
  /** Stands in for `sessionGate`'s resolved user, when a case signs one in. */
  signedInUser: undefined as { userId: string; credential: 'cookie' | 'api-key' } | undefined,
};

/**
 * What the stubbed config store answers: `auth` and `harness` from
 * {@link harnessState}, `permissions` for the shipped reader, and a throw naming
 * any other key, so a route that reached past its injected reader fails loudly.
 */
export function stubConfigGet(key: string): unknown {
  if (key === 'auth') return { enabled: harnessState.loginEnabled };
  if (key === 'harness') {
    return {
      approvedHooks: harnessState.hookDecisions.approved,
      refusedHooks: harnessState.hookDecisions.refused,
    };
  }
  if (key === 'permissions') return { preset: harnessState.storedPreset };
  throw new Error(`the harness router read config.${key} instead of its injected dependency`);
}

/**
 * An approval gateway that raises every card and decides none of them: a person
 * who has not looked at the screen. A route that awaited its cards would never
 * answer, which is what the VC-02 case is for.
 */
export const gateway = {
  /** Packages a card was raised for, in order. */
  requested: [] as string[],
  request(input: ApprovalRequestInput): ApprovalTicket {
    this.requested.push(
      input.packageRequest?.kind === 'hooks' ? input.packageRequest.request.packageName : 'unknown'
    );
    return {
      approvalId: `approval-${this.requested.length}`,
      token: `token-${this.requested.length}`,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    } as ApprovalTicket;
  },
  consume(_token: string, _binding: ApprovalBinding): ApprovalConsumeResult {
    return { outcome: 'pending' } as ApprovalConsumeResult;
  },
};

/**
 * The boundary root, the DorkOS data directory, and a directory outside both.
 * Dork-home sits OUTSIDE the boundary on purpose: `{dorkHome}/agents/*` being
 * reachable anyway is a case of its own.
 */
export const paths = { boundaryRoot: '', dorkHome: '', outside: '', emptyClaudeRoot: '' };

/** Temp directories to remove when the suite ends. */
export const staged: string[] = [];

/** The servers a suite talks to. */
export interface HarnessServers {
  /** The routes with {@link harnessState}'s reader and the undeciding gateway. */
  testServer: Server;
  /** A mount whose decisions reader throws {@link READ_FAILURE}. */
  failingServer: Server;
  /** A mount with no injected reader, reading the shipped `storedHookDecisions()`. */
  shippedReaderServer: Server;
}

let servers: HarnessServers;

/**
 * Register the suite's lifecycle and mount the routes.
 *
 * @param options.realConfig - Open a real config store in a folder of its own,
 *   for a piece that does not stub `configManager`.
 */
export function useHarnessRoutes(options: { realConfig?: boolean } = {}): HarnessServers {
  let app: RequestListener;
  let failingApp: RequestListener;
  let shippedReaderApp: RequestListener;
  servers = {
    testServer: listeningServer((req, res) => app(req, res)),
    failingServer: listeningServer((req, res) => failingApp(req, res)),
    shippedReaderServer: listeningServer((req, res) => shippedReaderApp(req, res)),
  };

  beforeAll(async () => {
    paths.boundaryRoot = realpathSync(mkdtempSync(join(tmpdir(), 'harness-route-boundary-')));
    paths.dorkHome = realpathSync(mkdtempSync(join(tmpdir(), 'harness-route-home-')));
    paths.outside = realpathSync(mkdtempSync(join(tmpdir(), 'harness-route-outside-')));
    staged.push(paths.boundaryRoot, paths.dorkHome, paths.outside);
    if (options.realConfig) {
      const configHome = mkdtempSync(join(tmpdir(), 'harness-route-config-'));
      staged.push(configHome);
      const { initConfigManager } = await import('../../../services/core/config-manager.js');
      initConfigManager(configHome);
    }
    await initBoundary(paths.boundaryRoot);
    // `validateBoundaryOrDorkHome` resolves `{dorkHome}/agents` off this.
    vi.stubEnv('DORK_HOME', paths.dorkHome);
    paths.emptyClaudeRoot = join(paths.outside, 'claude-root-that-is-not-there');
    pinEmptyClaudeRoot();
    const { dorkHome } = paths;
    // ONE mount per server: the first group matching a path serves it, so a
    // second `/api/harness` group beside this one would be dead code.
    app = honoGroupListener({
      path: '/api/harness',
      routes: createHarnessRoutes({
        dorkHome,
        readHookDecisions: () => harnessState.hookDecisions,
        approvals: gateway,
        dorkosHarness: () => 'claude-code',
      }),
    });
    shippedReaderApp = honoGroupListener({
      path: '/api/harness',
      routes: createHarnessRoutes({
        dorkHome,
        approvals: gateway,
        dorkosHarness: () => 'claude-code',
      }),
    });
    failingApp = honoGroupListener({
      path: '/api/harness',
      routes: createHarnessRoutes({
        dorkHome,
        readHookDecisions: () => {
          throw READ_FAILURE;
        },
        dorkosHarness: () => 'claude-code',
      }),
    });
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    for (const dir of staged.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  // Spies come off, `$CLAUDE_CONFIG_DIR` goes back, and so do the consent state
  // and the open-card memory `mayAskAboutHooks` reads.
  afterEach(() => {
    vi.restoreAllMocks();
    pinEmptyClaudeRoot();
    harnessState.hookDecisions = NO_DECISIONS;
    harnessState.loginEnabled = false;
    harnessState.storedPreset = 'trusted';
    harnessState.signedInUser = undefined;
    gateway.requested = [];
    askInternal.forgetDecisions();
  });

  return servers;
}

/**
 * Point `$CLAUDE_CONFIG_DIR` at a Claude root that does not exist, so no case
 * reads the settings of whichever developer ran it. Absent rather than empty,
 * because absent is the case the reader must answer silently.
 */
export function pinEmptyClaudeRoot(): void {
  vi.stubEnv('CLAUDE_CONFIG_DIR', paths.emptyClaudeRoot);
}

/** A fresh project directory inside the boundary. */
export function stageProject(tag: string): string {
  const repo = mkdtempSync(join(paths.boundaryRoot, `${tag}-`));
  staged.push(repo);
  return repo;
}

/** Write a file, creating the directories above it. */
export function writeAt(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

/** Write the manifest that turns a bare directory into a set-up project. */
export function writeManifest(repo: string, harnesses: string[]): void {
  writeAt(
    join(repo, '.agents', 'harness.manifest.json'),
    `${JSON.stringify({ version: 1, harnesses }, null, 2)}\n`
  );
}

// The trailing `.then` on these is not decoration: supertest's request object is
// LAZY and does not send until something subscribes. The lock cases hold the
// request while they assert about the queue.

/** The status read, as a client makes it. */
export function readStatus(projectPath: string): Promise<TestResponse> {
  return request(servers.testServer)
    .get('/api/harness/status')
    .query({ projectPath })
    .then((res) => res);
}

/** The sync, as the page makes it. */
export function syncProject(projectPath: string): Promise<TestResponse> {
  return request(servers.testServer)
    .post('/api/harness/sync')
    .send({ projectPath })
    .then((res) => res);
}

/** The adopt, as the page makes it. */
export function adoptSkill(
  projectPath: string,
  name: string,
  claudeOnly?: boolean
): Promise<TestResponse> {
  return request(servers.testServer)
    .post('/api/harness/adopt')
    .send({ projectPath, name, ...(claudeOnly === undefined ? {} : { claudeOnly }) })
    .then((res) => res);
}

/**
 * A project with one authored skill and, when asked, one project-scoped
 * marketplace plugin shipping a skill, a command and a hook: the shape §2.2.1 of
 * the spec measured (three harnesses, ten paths for a sweep to take once the
 * skill is deleted and the plugin uninstalled).
 */
export function stageSyncProject(tag: string, opts: { plugin?: boolean } = {}): string {
  const repo = stageProject(tag);
  writeManifest(repo, ['claude-code', 'codex', 'opencode']);
  writeAt(
    join(repo, '.agents', 'skills', 'alpha', 'SKILL.md'),
    '---\nname: alpha\ndescription: The alpha skill\n---\n\n# alpha\n'
  );
  if (opts.plugin !== true) return repo;

  const plugin = join(repo, '.dork', 'plugins', 'acme');
  writeAt(
    join(plugin, '.dork', 'manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      name: 'acme',
      version: '1.0.0',
      type: 'plugin',
      description: 'Acme test plugin',
      layers: ['skills', 'hooks', 'commands'],
    })
  );
  writeAt(
    join(plugin, 'skills', 'greet', 'SKILL.md'),
    '---\nname: greet\ndescription: The greet skill\n---\n\n# greet\n'
  );
  writeAt(join(plugin, 'commands', 'hello.md'), '---\ndescription: Say hello\n---\n\nSay hello.\n');
  writeAt(
    join(plugin, 'hooks', 'hooks.json'),
    JSON.stringify({ Stop: [{ hooks: [{ type: 'command', command: 'echo acme' }] }] })
  );
  return repo;
}

/**
 * Say yes, in advance, to every hook-declaring package in this project, built from
 * the production scanner and digest so a change to what a decision BINDS reds the
 * fixture instead of quietly un-approving it.
 */
export function allowEveryPackagesHooks(repo: string): void {
  harnessState.hookDecisions = {
    approved: scanHookRequests(repo, paths.dorkHome).map(hookApprovalEntry),
    refused: [],
  };
}

/**
 * A project with one skill in `.claude/skills`, with `claude-code` and `codex`
 * enabled: they disagree about it, which is what makes it adoptable.
 */
export function stageAdoptProject(tag: string, repo = stageProject(tag)): string {
  writeManifest(repo, ['claude-code', 'codex']);
  writeAt(
    join(repo, '.claude', 'skills', 'release-notes', 'SKILL.md'),
    '---\nname: release-notes\ndescription: How this release is written up\n---\n\n# release-notes\n'
  );
  return repo;
}
