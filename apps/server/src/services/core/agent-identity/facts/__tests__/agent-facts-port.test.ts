/**
 * The agent facts port end to end (spec `computer-side-starts-alone` §5.3,
 * C18): unwired it fails closed, startup fills every computer-side slot with
 * the space side's port, and what crosses it is plain data that parses with
 * its schema and survives JSON unchanged (proof D11).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import {
  AGENT_FACTS_UNWIRED,
  AgentBrowserGapSchema,
  AgentFactsSchema,
  AgentIdentityFactSchema,
  DeskRefusalSchema,
  HomeResolutionSchema,
  InstallDigestFactSchema,
  PackageSourceFactSchema,
  ProjectInstallFactSchema,
  RelayAdapterFactSchema,
  RelayBindingFactSchema,
  RelayBindingSessionFactSchema,
  TurnPromptFactsSchema,
  UNWIRED_AGENT_FACTS,
  UNWIRED_PACKAGE_FACTS,
} from '@dorkos/shared/agent-facts';
import { writeManifest } from '@dorkos/shared/manifest';
import { agentFacts, wireAgentFacts } from '../../../../../startup/agent-facts.js';
import { browserFacts, setBrowserFacts } from '../../../../browser/agent-facts.js';
import { mayRunGitIn, setGitGuard } from '../../../../core/git-status.js';
import { diffFacts, setDiffFacts } from '../../../../diff/agent-facts.js';
import { harnessPackageFacts, setHarnessPackageFacts } from '../../../../harness/agent-facts.js';
import { runtimeFacts, setRuntimeFacts } from '../../../../runtimes/agent-facts.js';
import {
  sessionAgentFacts,
  setSessionAgentFacts,
} from '../../../../session/turn-port/agent-facts.js';
import { setWorkspaceFacts, workspaceFacts } from '../../../../workspace/agent-facts.js';
import { setAgentHomeRegistry } from '../../agent-home.js';
import { setAgentFactSources } from '../index.js';

const AGENT_ID = '01JAGENTFACTS0000000000000';

/** Parse with the schema and through JSON, and expect the same value both times. */
function roundTrips<T>(schema: z.ZodType<T>, value: T): void {
  expect(schema.parse(value)).toEqual(value);
  expect(JSON.parse(JSON.stringify(value))).toEqual(value);
}

const clearSlots = () => {
  setRuntimeFacts(undefined);
  setSessionAgentFacts(undefined);
  setWorkspaceFacts(undefined);
  setDiffFacts(undefined);
  setGitGuard(undefined);
  setBrowserFacts(undefined);
  setHarnessPackageFacts(undefined);
};

let root: string;
let home: string;
let stranger: string;
let dorkHome: string;

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-facts-')));
  home = path.join(root, 'agents', 'ledger');
  stranger = path.join(root, 'agents', 'other');
  dorkHome = path.join(root, 'dork');
  for (const dir of [home, stranger, dorkHome]) fs.mkdirSync(dir, { recursive: true });
  await writeManifest(home, {
    workspace: { mode: 'home' },
    id: AGENT_ID,
    name: 'ledger',
    description: 'Keeps the books',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: '2026-11-01T00:00:00.000Z',
    registeredBy: 'test-suite',
    personaEnabled: true,
    isSystem: false,
    mcpServers: [],
  });
  fs.writeFileSync(path.join(home, '.dork', 'SOUL.md'), 'Careful with numbers.\n');
});

afterEach(() => {
  clearSlots();
  setAgentHomeRegistry(undefined);
  setAgentFactSources(undefined);
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('unwired', () => {
  it('every slot reads the fail-closed port', () => {
    clearSlots();
    for (const read of [runtimeFacts, sessionAgentFacts, workspaceFacts, diffFacts]) {
      expect(read()).toBe(UNWIRED_AGENT_FACTS);
    }
    expect(browserFacts()).toBe(UNWIRED_AGENT_FACTS);
    // Git status and the file lister hold only git's kill switch, and it answers no.
    expect(mayRunGitIn(home)).toBe(false);
    expect(harnessPackageFacts()).toBe(UNWIRED_PACKAGE_FACTS);
  });

  it('knows no home, runs git nowhere, accepts no desk and mints no token', async () => {
    const facts = runtimeFacts();
    expect(facts.home(home)).toEqual({ kind: 'none' });
    expect(facts.home(home, home)).toEqual({ kind: 'refused', reason: 'unregistered-owner' });
    expect(facts.mayRunGit(home)).toBe(false);
    // A launch is refused inside the rooms' files, so unwired every folder counts as one.
    expect(facts.insideRoomsDir(home)).toBe(true);
    const refusal = facts.deskRefusal(home, home, 'home');
    expect(refusal?.message).toBe(AGENT_FACTS_UNWIRED);
    roundTrips(DeskRefusalSchema, refusal!);
    expect(await facts.launchTokenEnv(home, 'Ledger')).toEqual({});
    expect(await facts.describeAgent(home)).toBeUndefined();
    expect(await facts.list()).toEqual([]);
    expect(facts.promptFacts()).toEqual({
      tasksEnabled: false,
      relayEnabled: false,
      memoryBenched: false,
    });
  });

  it('names the missing wiring rather than leave a block out', async () => {
    const facts = runtimeFacts();
    expect(() =>
      facts.renderDocEvents({ documentId: 'doc', label: 'Doc', records: [] } as never)
    ).toThrow(AGENT_FACTS_UNWIRED);
    await expect(facts.memoryNotesLine(AGENT_ID, home as never)).rejects.toThrow(
      AGENT_FACTS_UNWIRED
    );
    await expect(harnessPackageFacts().packageSources(dorkHome)).rejects.toThrow(
      AGENT_FACTS_UNWIRED
    );
  });
});

describe('wired', () => {
  it('fills every computer-side slot with one port', () => {
    wireAgentFacts();
    for (const read of [runtimeFacts, sessionAgentFacts, workspaceFacts, diffFacts]) {
      expect(read()).toBe(agentFacts);
    }
    expect(browserFacts()).toBe(agentFacts);
    expect(harnessPackageFacts()).toBe(agentFacts);
  });

  it("hands git status and the file lister only git's kill switch, read from the port", () => {
    let asked: string | undefined;
    wireAgentFacts({ ...agentFacts, mayRunGit: (dir) => ((asked = dir), true) });
    expect(mayRunGitIn(home)).toBe(true);
    expect(asked).toBe(home);
  });

  it("serves an agent's facts as the agents.sync body plus its home, desks and author", async () => {
    setAgentFactSources({
      agents: () => [{ id: AGENT_ID, projectPath: home }],
      desksOf: () => [path.join(root, 'checkouts', 'ledger-1')],
      authorIdOf: () => '01JAUTHOR00000000000000000',
      packagesOf: async () => [{ name: 'bookkeeping', version: '1.2.0' }],
    });
    const facts = await agentFacts.get(AGENT_ID);
    expect(facts).toMatchObject({
      op: 'agents.sync',
      agentId: AGENT_ID,
      home,
      files: [{ name: 'SOUL.md', text: 'Careful with numbers.\n' }],
      packages: [{ name: 'bookkeeping', version: '1.2.0' }],
      authorId: '01JAUTHOR00000000000000000',
    });
    roundTrips(AgentFactsSchema, facts!);
    expect(await agentFacts.list()).toEqual([facts]);
    expect(await agentFacts.get('01JNOBODY00000000000000000')).toBeNull();
  });

  it('answers whose home a folder is, and refuses another agent its desk', () => {
    setAgentHomeRegistry({
      isRegisteredHome: (dir) => dir === home || dir === stranger,
      listRegisteredHomes: () => [home, stranger],
      managedWorkspaceOwner: () => null,
      roomsDir: path.join(dorkHome, 'rooms'),
    });
    const own = agentFacts.home(home);
    expect(own).toEqual({ kind: 'home', home, via: 'exact' });
    roundTrips(HomeResolutionSchema, own);
    const refused = agentFacts.home(stranger, home);
    expect(refused).toEqual({ kind: 'refused', reason: 'not-the-turns-agent' });
    roundTrips(HomeResolutionSchema, refused);
    roundTrips(HomeResolutionSchema, agentFacts.home(undefined));

    expect(agentFacts.deskRefusal(home, home, 'home')).toBeNull();
    const refusal = agentFacts.deskRefusal(home, stranger, 'home');
    expect(refusal?.message).toContain('belongs to another agent');
    roundTrips(DeskRefusalSchema, refusal!);
    expect(agentFacts.insideRoomsDir(path.join(dorkHome, 'rooms', 'r1'))).toBe(true);
  });

  it('serves the prompt switches, identities and package reads as plain data', async () => {
    roundTrips(TurnPromptFactsSchema, agentFacts.promptFacts());
    roundTrips(AgentIdentityFactSchema, {
      agentPath: home,
      displayName: 'Ledger',
      createdAt: '2026-11-01T00:00:00.000Z',
    });
    for (const source of await agentFacts.packageSources(dorkHome)) {
      roundTrips(PackageSourceFactSchema, source);
    }
    expect(await agentFacts.cachedPackageNames(dorkHome, 'nowhere')).toBeNull();
    const installs = await agentFacts.projectInstalls(dorkHome);
    for (const install of installs) roundTrips(ProjectInstallFactSchema, install);
    roundTrips(InstallDigestFactSchema, await agentFacts.installDigest(home));
    roundTrips(InstallDigestFactSchema, await agentFacts.installDigest(path.join(root, 'gone')));
    const gap = agentFacts.agentBrowserGap(path.join(root, 'gone', 'state.json'));
    expect(gap).toBe('missing');
    roundTrips(AgentBrowserGapSchema, gap!);
  });

  it('reads relay connections in shapes the relay stores answer', () => {
    roundTrips(RelayBindingFactSchema, {
      id: 'b1',
      adapterId: 'telegram-main',
      agentId: AGENT_ID,
      canInitiate: true,
    });
    roundTrips(RelayBindingSessionFactSchema, { scope: 'chat', chatId: '4242' });
    roundTrips(RelayAdapterFactSchema, {
      config: { id: 'telegram-main', type: 'telegram', label: 'Team' },
      status: { state: 'connected' },
    });
  });
});
