/**
 * An agent that came from a marketplace package owns every schedule filed under
 * it — and DorkOS refuses at BOTH doors (DOR-1789).
 *
 * ## Why this drives the lifecycle functions rather than `isPackageOwned`
 *
 * The first version of the DOR-1789 fix was covered by tests that built the
 * ownership roots by hand and passed them in. Those tests were green while
 * production was broken, because the roots they built were not the roots the
 * route builds. `meshCore.getProjectPath(agentId)` returns `registry.projectPath`
 * — the agent's OWN directory — so for an agent package installed at
 * `<repo>/.dork/agents/helper` the route derived a scope root of
 * `<repo>/.dork/agents/helper/.dork`, whose install roots never include
 * `<repo>/.dork/agents`, the one root that would have caught it. A hand-built
 * `packageInstallRoots(dorkHome, repoPath)` DID include it, so the test asked a
 * question the route never asks (DOR-1789 review).
 *
 * So every case here goes through {@link applyTaskFileUpdate} or
 * {@link createScheduledTask} with a `meshCore` that answers exactly as the real
 * one does: the agent's own directory, and nothing above it.
 *
 * @module services/tasks/lifecycle/__tests__/package-owned-agent
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { TaskStore } from '../../task-store.js';
import { applyTaskFileUpdate } from '../update-task-file.js';
import { createScheduledTask } from '../create-task.js';

let db: Db;
let store: TaskStore;
let root: string;
let dorkHome: string;
/** A checkout on disk that is NOT the data directory — where a project install lands. */
let repo: string;

beforeEach(async () => {
  db = createTestDb();
  store = new TaskStore(db);
  // Resolved: on macOS every temp directory is a symlink, and the ownership
  // check compares real paths on both sides.
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-pkg-agent-')));
  dorkHome = path.join(root, 'dork');
  repo = path.join(root, 'repo');
  await fs.mkdir(dorkHome, { recursive: true });
  await fs.mkdir(repo, { recursive: true });
});

afterEach(async () => {
  store.close();
  await fs.rm(root, { recursive: true, force: true });
});

/** A schedule file's bytes. */
const SKILL =
  "---\nname: nightly-sweep\ndescription: packaged\nschedule:\n  cron: '0 3 * * *'\n---\npackaged prompt";

/**
 * Stand up an agent directory, optionally marked as an installed package.
 *
 * @param agentDir - Where the agent lives.
 * @param marker - The install marker to write, or `null` for an agent a person
 *   made (which has `.dork/agent.json` and nothing else).
 * @returns The agent's schedule file, written and ready to edit.
 */
async function makeAgent(
  agentDir: string,
  marker: 'manifest.json' | 'install-metadata.json' | null
): Promise<string> {
  await fs.mkdir(path.join(agentDir, '.dork'), { recursive: true });
  // Every agent has this one, package or not — which is exactly why it cannot
  // be the marker that tells them apart.
  await fs.writeFile(path.join(agentDir, '.dork', 'agent.json'), '{}', 'utf-8');
  if (marker) {
    await fs.writeFile(
      path.join(agentDir, '.dork', marker),
      JSON.stringify({ name: 'helper', version: '1.0.0', type: 'agent' }),
      'utf-8'
    );
  }
  const filePath = path.join(agentDir, '.agents', 'skills', 'nightly-sweep', 'SKILL.md');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, SKILL, 'utf-8');
  return filePath;
}

/** A mesh that resolves this task's agent to `dir`, as the registry does. */
const meshFor = (dir: string) => ({ getProjectPath: () => dir });

/** A mesh that is up, but no longer has this agent — a deregistered one. */
const meshWithoutAgent = { getProjectPath: () => undefined };

/**
 * Edit a schedule through the shared update door.
 *
 * @param filePath - The task's file on disk.
 * @param meshCore - What the route gets from mesh: a resolver, or `undefined`
 *   for a server whose mesh never came up.
 */
async function editSchedule(filePath: string, meshCore: unknown) {
  const task = store.createTask({
    name: 'nightly-sweep',
    description: 'packaged',
    prompt: 'packaged prompt',
    cron: '0 3 * * *',
    filePath,
    agentId: 'agent-1',
  });
  return applyTaskFileUpdate({ dorkHome, meshCore } as never, {
    existing: task,
    data: { prompt: 'a different job' } as never,
  });
}

/**
 * File a NEW schedule under an agent, through the shared create door.
 *
 * @param agentDir - What `getProjectPath` returns for the named target.
 */
async function createSchedule(agentDir: string) {
  return createScheduledTask(
    {
      store,
      registrar: null,
      dorkHome,
      meshCore: { getProjectPath: () => agentDir } as never,
    },
    {
      input: {
        name: 'my-own-sweep',
        description: 'mine',
        prompt: 'sweep it',
        cron: '0 4 * * *',
        target: 'helper',
      } as never,
      trusted: true,
    }
  );
}

describe('a schedule filed under an installed agent package', () => {
  it('is refused by the update door when the package is PROJECT-scoped', async () => {
    // The case the first fix missed entirely. `<repo>/.dork/agents/helper` is
    // where `AgentInstallFlow` puts a project-scoped agent package, and the only
    // thing the route knows about it is the agent's own directory.
    const agentDir = path.join(repo, '.dork', 'agents', 'helper');
    const filePath = await makeAgent(agentDir, 'manifest.json');

    const outcome = await editSchedule(filePath, meshFor(agentDir));

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.code).toBe('schedule_package_owned');
    expect(await fs.readFile(filePath, 'utf-8')).toContain('packaged prompt');
  });

  it('is refused by the update door when the package is GLOBAL', async () => {
    const agentDir = path.join(dorkHome, 'agents', 'helper');
    const filePath = await makeAgent(agentDir, 'manifest.json');

    const outcome = await editSchedule(filePath, meshFor(agentDir));

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.code).toBe('schedule_package_owned');
  });

  it('is refused on the install sidecar alone, with no manifest', async () => {
    const agentDir = path.join(repo, '.dork', 'agents', 'helper');
    const filePath = await makeAgent(agentDir, 'install-metadata.json');

    const outcome = await editSchedule(filePath, meshFor(agentDir));

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.code).toBe('schedule_package_owned');
  });

  it('is refused by the CREATE door too, before anything is written', async () => {
    // Refusing update alone left a dead end: the person made a schedule DorkOS
    // accepted, then was told it belonged to a package the moment they changed
    // it — untrue of a file they had just made (DOR-1789 review).
    const agentDir = path.join(repo, '.dork', 'agents', 'helper');
    await makeAgent(agentDir, 'manifest.json');

    const outcome = await createSchedule(agentDir);

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.code).toBe('schedule_package_owned');
    // Nothing on disk: the refusal comes before the write, not after it.
    await expect(
      fs.access(path.join(agentDir, '.agents', 'skills', 'my-own-sweep'))
    ).rejects.toThrow();
  });
});

describe('an agent the person made keeps its schedules', () => {
  it('lets the update door rewrite the file, wherever the agent lives', async () => {
    // The over-refusal direction. An agent a person made inside a repo sits at
    // the same depth as a project-scoped package and must NOT be mistaken for
    // one — the marker is the whole difference.
    const agentDir = path.join(repo, '.dork', 'agents', 'mine');
    const filePath = await makeAgent(agentDir, null);

    const outcome = await editSchedule(filePath, meshFor(agentDir));

    expect(outcome.ok).toBe(true);
    expect(await fs.readFile(filePath, 'utf-8')).toContain('a different job');
  });

  it('lets the create door file a new one', async () => {
    const agentDir = path.join(repo, '.dork', 'agents', 'mine');
    await makeAgent(agentDir, null);

    const outcome = await createSchedule(agentDir);

    expect(outcome.ok).toBe(true);
    await expect(
      fs.access(path.join(agentDir, '.agents', 'skills', 'my-own-sweep', 'SKILL.md'))
    ).resolves.toBeUndefined();
  });

  it('still refuses a file that sits in a PLUGIN checkout, agent or no agent', async () => {
    // The location-alone limb, which the agent probe does not replace: a
    // `skillRef` schedule inside a plugin's own install root is package-owned no
    // matter which agent the row is filed under.
    const agentDir = path.join(repo, '.dork', 'agents', 'mine');
    await makeAgent(agentDir, null);
    // The directory name has to match the skill's `name`, or the parse gate
    // refuses first and this case would prove nothing about ownership.
    const filePath = path.join(dorkHome, 'plugins', 'pack', 'skills', 'nightly-sweep', 'SKILL.md');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, SKILL, 'utf-8');

    const outcome = await editSchedule(filePath, meshFor(agentDir));

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.code).toBe('schedule_package_owned');
  });
});

describe('the answer does not depend on mesh being able to give it', () => {
  // Replacing the `agents/` root walk with the agent-directory probe made mesh
  // load-bearing for the whole answer, and each state below is one a running
  // server reaches: the protection simply switched off, silently, and a package
  // checkout became writable. The marker-gated root walk is back beside the
  // probe so that any ONE of them answering is enough (DOR-1789 re-review).

  /** A GLOBAL agent package, which the `agents/` root walk can see. */
  async function installedAgent(): Promise<{ agentDir: string; filePath: string }> {
    const agentDir = path.join(dorkHome, 'agents', 'helper');
    return { agentDir, filePath: await makeAgent(agentDir, 'manifest.json') };
  }

  it('still refuses when mesh never came up at all', async () => {
    // `meshCore` is undefined on a server whose mesh failed to initialize. With
    // the probe as the only limb, EVERY package file became writable.
    const { filePath } = await installedAgent();

    const outcome = await editSchedule(filePath, undefined);

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.code).toBe('schedule_package_owned');
    expect(await fs.readFile(filePath, 'utf-8')).toContain('packaged prompt');
  });

  it('still refuses when the agent has left the registry', async () => {
    // Mesh is up and answers `undefined` for this agent. Its rows outlive
    // deregistration and stay patchable, so the file is still reachable.
    const { filePath } = await installedAgent();

    const outcome = await editSchedule(filePath, meshWithoutAgent);

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.code).toBe('schedule_package_owned');
  });

  it('still refuses when reached through ANOTHER agent’s skills root', async () => {
    // A symlink from a different agent's `.agents/skills/` into the package. The
    // row's own agent is that other agent, whose directory does not contain the
    // resolved file, so the probe cannot answer — only the root walk can.
    const { filePath } = await installedAgent();
    const otherAgent = path.join(repo, '.dork', 'agents', 'mine');
    await makeAgent(otherAgent, null);
    // The link stands where that agent's own skill of this name would be: the
    // directory basename has to keep matching the skill's `name`, or the parse
    // gate refuses first and the case proves nothing about ownership.
    const link = path.join(otherAgent, '.agents', 'skills', 'nightly-sweep');
    await fs.rm(link, { recursive: true, force: true });
    await fs.symlink(path.dirname(filePath), link);

    const outcome = await editSchedule(path.join(link, 'SKILL.md'), meshFor(otherAgent));

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.code).toBe('schedule_package_owned');
    expect(await fs.readFile(filePath, 'utf-8')).toContain('packaged prompt');
  });
});
