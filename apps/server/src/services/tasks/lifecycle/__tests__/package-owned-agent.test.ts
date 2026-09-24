/**
 * Who owns a schedule filed under an agent that came from a marketplace
 * package, asked at BOTH task doors (DOR-1789, DOR-2272).
 *
 * ## The rule under test
 *
 * An install root carries an installed-files record (DOR-2245). A file the
 * record lists, and that the package did not mark `userEditable`, is the
 * package's: its next update puts its own copy back, so DorkOS does not write
 * it. Every other file in the root is the person's, survives every update, and
 * is edited like any other schedule. An install made before records existed has
 * none, and keeps the DOR-1789 answer (location for plugin and Shape roots, a
 * marker for agent directories) until an update rebuilds one.
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
 * `<repo>/.dork/agents`, the one root that would have caught it (DOR-1789
 * review).
 *
 * So every case here goes through {@link applyTaskFileUpdate} or
 * {@link createScheduledTask} with a `meshCore` that answers exactly as the real
 * one does: the agent's own directory, and nothing above it. Records are built
 * by `computeInstalledFiles`, the function an install runs, so the paths and the
 * exclusions are the ones production writes.
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
import {
  computeInstalledFiles,
  writeInstalledFiles,
} from '../../../marketplace/lib/installed-files.js';

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

/** Where a schedule named `slug` lives under an agent. */
const scheduleFile = (agentDir: string, slug = 'nightly-sweep') =>
  path.join(agentDir, '.agents', 'skills', slug, 'SKILL.md');

/**
 * How an agent came to be on disk.
 *
 * - `recorded`: installed by a DorkOS that writes the installed-files record.
 * - `legacy-manifest` / `legacy-sidecar`: installed before records existed,
 *   recognisable only by the marker it carries.
 * - `hand-made`: an agent a person made, with `.dork/agent.json` and nothing else.
 */
type AgentKind = 'recorded' | 'legacy-manifest' | 'legacy-sidecar' | 'hand-made';

/**
 * Stand up an agent directory shipping one schedule, `nightly-sweep`.
 *
 * @param agentDir - Where the agent lives.
 * @param kind - How it came to be there.
 * @param userEditable - The package's `userEditable`, for a recorded install.
 * @returns The agent's shipped schedule file, written and ready to edit.
 */
async function makeAgent(
  agentDir: string,
  kind: AgentKind,
  userEditable: string[] = []
): Promise<string> {
  await fs.mkdir(path.join(agentDir, '.dork'), { recursive: true });
  const filePath = scheduleFile(agentDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, SKILL, 'utf-8');
  const manifest = JSON.stringify({ name: 'helper', version: '1.0.0', type: 'agent' });
  if (kind === 'recorded' || kind === 'legacy-manifest') {
    await fs.writeFile(path.join(agentDir, '.dork', 'manifest.json'), manifest, 'utf-8');
  }
  if (kind === 'recorded') {
    // Taken before the scaffold writes agent.json, as an install takes it from
    // the staged tree; agent.json is an identity file and never recorded anyway.
    const record = await computeInstalledFiles(agentDir, {
      identity: { name: 'helper', type: 'agent' },
      userEditable,
      npmRan: false,
    });
    await writeInstalledFiles(agentDir, record);
    await fs.writeFile(path.join(agentDir, '.dork', 'install-metadata.json'), manifest, 'utf-8');
  }
  if (kind === 'legacy-sidecar') {
    await fs.writeFile(path.join(agentDir, '.dork', 'install-metadata.json'), manifest, 'utf-8');
  }
  // Every agent has this one, package or not — which is exactly why it cannot
  // be the marker that tells them apart.
  await fs.writeFile(path.join(agentDir, '.dork', 'agent.json'), '{}', 'utf-8');
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
 * @param name - The schedule's name, which must match its directory.
 */
async function editSchedule(filePath: string, meshCore: unknown, name = 'nightly-sweep') {
  const task = store.createTask({
    name,
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
 * @param name - The new schedule's name.
 */
async function createSchedule(agentDir: string, name = 'my-own-sweep') {
  return createScheduledTask(
    {
      store,
      registrar: null,
      dorkHome,
      meshCore: { getProjectPath: () => agentDir } as never,
    },
    {
      input: {
        name,
        description: 'mine',
        prompt: 'sweep it',
        cron: '0 4 * * *',
        target: 'helper',
      } as never,
      trusted: true,
    }
  );
}

/** Where each scope puts an agent package. */
const SCOPES = {
  project: () => path.join(repo, '.dork', 'agents', 'helper'),
  global: () => path.join(dorkHome, 'agents', 'helper'),
} as const;

describe.each(Object.entries(SCOPES))('a recorded agent package at %s scope', (_, dirOf) => {
  it('refuses to rewrite a schedule the package shipped', async () => {
    // The record lists it, so the package's next update puts its own copy
    // back: an edit here would be silently undone.
    const agentDir = dirOf();
    const filePath = await makeAgent(agentDir, 'recorded');

    const outcome = await editSchedule(filePath, meshFor(agentDir));

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.code).toBe('schedule_package_owned');
    expect(await fs.readFile(filePath, 'utf-8')).toContain('packaged prompt');
  });

  it('lets a person make a schedule for the agent, and then edit it', async () => {
    // The capability DOR-1789 took away. The new file is not in the record,
    // so an update keeps it (DOR-2245), and the edit door must agree with the
    // create door about whose it is.
    const agentDir = dirOf();
    await makeAgent(agentDir, 'recorded');

    const created = await createSchedule(agentDir);

    expect(created.ok).toBe(true);
    const mine = scheduleFile(agentDir, 'my-own-sweep');
    await expect(fs.access(mine)).resolves.toBeUndefined();
    const edited = await editSchedule(mine, meshFor(agentDir), 'my-own-sweep');
    expect(edited.ok).toBe(true);
    expect(await fs.readFile(mine, 'utf-8')).toContain('a different job');
  });
});

describe('a recorded agent package, edge cases', () => {
  const agentDir = () => SCOPES.project();

  it('still refuses a shipped schedule whose bytes were changed after install', async () => {
    // Ownership asks what the next update does, not whether the bytes still
    // match: a listed file is replaced either way, so an edit that already
    // happened on disk does not make the file the person's to write.
    const filePath = await makeAgent(agentDir(), 'recorded');
    await fs.writeFile(filePath, SKILL.replace('packaged prompt', 'hand edited'), 'utf-8');

    const outcome = await editSchedule(filePath, meshFor(agentDir()));

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.code).toBe('schedule_package_owned');
  });

  it('lets a person edit a shipped schedule the package marked userEditable', async () => {
    // A userEditable file keeps the person's copy on update, so writing it
    // loses nothing.
    const filePath = await makeAgent(agentDir(), 'recorded', ['.agents/skills/**']);

    const outcome = await editSchedule(filePath, meshFor(agentDir()));

    expect(outcome.ok).toBe(true);
    expect(await fs.readFile(filePath, 'utf-8')).toContain('a different job');
  });

  it('refuses to create a schedule under a name the package ships, even once deleted', async () => {
    // The record still lists it, so the next update brings the package's file
    // back at exactly this path and the person's schedule would be replaced.
    const filePath = await makeAgent(agentDir(), 'recorded');
    await fs.rm(path.dirname(filePath), { recursive: true });

    const outcome = await createSchedule(agentDir(), 'nightly-sweep');

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.code).toBe('schedule_package_owned');
    expect(!outcome.ok && outcome.error).toContain('already has a schedule called "nightly-sweep"');
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it('refuses that name even when mesh names the agent through a symlinked path', async () => {
    // The file does not exist yet, so it cannot be realpath'd itself; its
    // deepest existing ancestor must be, or the path never matches the
    // resolved install root and the create door waves the name through.
    const filePath = await makeAgent(agentDir(), 'recorded');
    await fs.rm(path.dirname(filePath), { recursive: true });
    const alias = path.join(root, 'alias');
    await fs.symlink(repo, alias);
    const aliasedAgentDir = path.join(alias, path.relative(repo, agentDir()));

    const outcome = await createSchedule(aliasedAgentDir, 'nightly-sweep');

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.code).toBe('schedule_package_owned');
  });

  it('claims nothing once the package is uninstalled', async () => {
    // An uninstall leaves a pruned record (`uninstalledAt`) listing the edited
    // files it kept. No package is there to put anything back.
    const filePath = await makeAgent(agentDir(), 'recorded');
    const recordPath = path.join(agentDir(), '.dork', 'installed-files.json');
    const record = JSON.parse(await fs.readFile(recordPath, 'utf-8'));
    await fs.writeFile(
      recordPath,
      JSON.stringify({ ...record, uninstalledAt: '2026-09-24T00:00:00.000Z' }),
      'utf-8'
    );

    const outcome = await editSchedule(filePath, meshFor(agentDir()));

    expect(outcome.ok).toBe(true);
  });
});

describe('an agent package installed before records existed', () => {
  it.each(['legacy-manifest', 'legacy-sidecar'] as const)(
    'refuses to rewrite its schedules (%s)',
    async (kind) => {
      // Without a record DorkOS cannot tell the package's files from the
      // person's, so the marker-based answer stands until an update writes one.
      const agentDir = SCOPES.project();
      const filePath = await makeAgent(agentDir, kind);

      const outcome = await editSchedule(filePath, meshFor(agentDir));

      expect(outcome.ok).toBe(false);
      expect(!outcome.ok && outcome.code).toBe('schedule_package_owned');
    }
  );

  it('refuses to create one, says how to get out, and writes nothing', async () => {
    // Create must refuse what update would refuse, or the person makes a
    // schedule they are then told they cannot change (DOR-1789 review).
    const agentDir = SCOPES.project();
    await makeAgent(agentDir, 'legacy-manifest');

    const outcome = await createSchedule(agentDir);

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.code).toBe('schedule_package_owned');
    expect(!outcome.ok && outcome.error).toContain('Update or reinstall the package once');
    await expect(fs.access(scheduleFile(agentDir, 'my-own-sweep'))).rejects.toThrow();
  });
});

describe('an agent the person made keeps its schedules', () => {
  it('lets the update door rewrite the file, wherever the agent lives', async () => {
    // The over-refusal direction. An agent a person made inside a repo sits at
    // the same depth as a project-scoped package and must NOT be mistaken for
    // one — the marker is the whole difference.
    const agentDir = path.join(repo, '.dork', 'agents', 'mine');
    const filePath = await makeAgent(agentDir, 'hand-made');

    const outcome = await editSchedule(filePath, meshFor(agentDir));

    expect(outcome.ok).toBe(true);
    expect(await fs.readFile(filePath, 'utf-8')).toContain('a different job');
  });

  it('lets the create door file a new one', async () => {
    const agentDir = path.join(repo, '.dork', 'agents', 'mine');
    await makeAgent(agentDir, 'hand-made');

    const outcome = await createSchedule(agentDir);

    expect(outcome.ok).toBe(true);
    await expect(fs.access(scheduleFile(agentDir, 'my-own-sweep'))).resolves.toBeUndefined();
  });
});

describe('a schedule inside a plugin checkout, filed under a hand-made agent', () => {
  /** Put `nightly-sweep` into a plugin install, optionally recording it. */
  async function pluginSchedule(recorded: 'none' | 'listed' | 'unlisted'): Promise<string> {
    const pluginDir = path.join(dorkHome, 'plugins', 'pack');
    // The directory name has to match the skill's `name`, or the parse gate
    // refuses first and the case would prove nothing about ownership.
    const filePath = path.join(pluginDir, 'skills', 'nightly-sweep', 'SKILL.md');
    await fs.mkdir(path.join(pluginDir, '.claude-plugin'), { recursive: true });
    await fs.writeFile(path.join(pluginDir, '.claude-plugin', 'plugin.json'), '{}', 'utf-8');
    // A listed schedule is on disk when the record is taken; an unlisted one
    // arrives after, as a person's file would.
    if (recorded === 'listed') {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, SKILL, 'utf-8');
    }
    if (recorded !== 'none') {
      const record = await computeInstalledFiles(pluginDir, {
        identity: { name: 'pack', type: 'plugin' },
        userEditable: [],
        npmRan: false,
      });
      await writeInstalledFiles(pluginDir, record);
    }
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, SKILL, 'utf-8');
    return filePath;
  }

  it('refuses one the plugin recorded', async () => {
    const agentDir = path.join(repo, '.dork', 'agents', 'mine');
    await makeAgent(agentDir, 'hand-made');
    const filePath = await pluginSchedule('listed');

    const outcome = await editSchedule(filePath, meshFor(agentDir));

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.code).toBe('schedule_package_owned');
  });

  it('refuses one in a plugin installed before records existed, by location', async () => {
    // A plugin root holds nothing a person put there by DorkOS's hand, so
    // location is the whole legacy answer — no marker read at all.
    const agentDir = path.join(repo, '.dork', 'agents', 'mine');
    await makeAgent(agentDir, 'hand-made');
    const filePath = await pluginSchedule('none');

    const outcome = await editSchedule(filePath, meshFor(agentDir));

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.code).toBe('schedule_package_owned');
  });

  it('refuses a file under a path the install owns wholesale', async () => {
    // `node_modules` is recorded as an owned path, not file by file: the npm
    // step rewrites all of it on every install, so nothing in it is a person's.
    const agentDir = path.join(repo, '.dork', 'agents', 'mine');
    await makeAgent(agentDir, 'hand-made');
    const pluginDir = path.join(dorkHome, 'plugins', 'pack');
    await fs.mkdir(path.join(pluginDir, 'node_modules'), { recursive: true });
    const record = await computeInstalledFiles(pluginDir, {
      identity: { name: 'pack', type: 'plugin' },
      userEditable: [],
      npmRan: true,
    });
    await writeInstalledFiles(pluginDir, record);
    const filePath = path.join(pluginDir, 'node_modules', 'dep', 'nightly-sweep', 'SKILL.md');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, SKILL, 'utf-8');

    const outcome = await editSchedule(filePath, meshFor(agentDir));

    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.code).toBe('schedule_package_owned');
  });

  it('lets a person edit a file they added to a recorded plugin', async () => {
    // Unlisted, so the plugin's update keeps it (DOR-2245 row 9); refusing it
    // would protect nothing.
    const agentDir = path.join(repo, '.dork', 'agents', 'mine');
    await makeAgent(agentDir, 'hand-made');
    const filePath = await pluginSchedule('unlisted');

    const outcome = await editSchedule(filePath, meshFor(agentDir));

    expect(outcome.ok).toBe(true);
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
    const agentDir = SCOPES.global();
    return { agentDir, filePath: await makeAgent(agentDir, 'recorded') };
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
    await makeAgent(otherAgent, 'hand-made');
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
