/**
 * J-12 — two writers on one repo at once (AP-10).
 *
 * Two DorkOS processes really do share a repository: the dev server on :6242 and
 * the built app on :4242 on the maintainer's own machine, a `dorkos harness sync
 * --fix` in a terminal beside a running app, a marketplace install landing while
 * somebody's sync is halfway through. Nothing serializes them — the in-process
 * lock (`services/harness/project-with-consent.ts`) cannot reach across a process
 * boundary and deliberately does not try. So this stages the race for real, in
 * two CHILD PROCESSES, and asks what a person is left holding.
 *
 * The two halves are different questions, and neither answers the other:
 *
 * - **Same plan, converging.** Both writers read the same tree, so they write
 *   the same bytes; whichever renames last should leave exactly the tree one
 *   sequential sync leaves. A hundred interleaved applies later, `checkPlan` is
 *   clean, the tree is byte-identical to the sequential one, and every ownership
 *   sidecar still matches the file beside it.
 * - **Different plans, never spliced.** The realistic divergence is TIME: one
 *   process planned before a second plugin's files landed and the other planned
 *   after, so their bytes differ and the last writer wins. What must never
 *   happen is a third thing — a file holding neither version. A reader in the
 *   parent polls the generated hooks file throughout and every value it sees is
 *   one complete version or the other.
 *
 * **What this deliberately does NOT claim.** In the second half the generated
 * file and its `.dorkos-generated` sidecar are two writes, and two processes
 * writing DIFFERENT bytes can interleave them so the sidecar ends up describing
 * the other one's file. DOR-1842's rule then reports that pair as a conflict —
 * safe, and wrong. Closing it needs a cross-process lock with a stale-lock story,
 * which `project-with-consent.ts` argues against and this test therefore does not
 * assert away.
 *
 * **What this found, and the two seeded reds.** The first half failed on its
 * very first run, and not on anything it was written to check: `applySymlink`
 * was a check-then-act, so the second writer's `symlinkSync` threw EEXIST and
 * took the whole apply down — a `--fix` that exits 1 for no reason a person
 * could act on. Reverting that fix reds this file three times out of three.
 * Reverting `writeFileAtomic` to a plain `writeFileSync` reds the second half:
 * the polling reader catches `.codex/hooks.json` EMPTY, which is what a Codex
 * session starting in that instant would have loaded.
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { project } from '../../engine.js';
import { applyPlan, checkPlan } from '../../apply/apply.js';
import { CODEX_HOOKS_TARGET, GENERATED_HOOK_TARGETS } from '../../generate/hooks.js';
import { GENERATED_SIDECAR_SUFFIX } from '../../apply/generated-ownership.js';
import { scrubbedSnapshot, writeFileAt, writeJsonAt } from './stage.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE_URL = pathToFileURL(join(HERE, '..', '..', 'engine.ts')).href;
const APPLY_URL = pathToFileURL(join(HERE, '..', '..', 'apply', 'apply.ts')).href;
/** The TypeScript loader the children need, since they import the engine's source. */
const TSX_LOADER_URL = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

/** How many project + apply passes each writer makes while the other is doing the same. */
const ROUNDS = 50;

/**
 * What a writer child runs: import the real engine, announce readiness, spin on
 * a barrier so both writers start in the same instant, then project and apply
 * over and over.
 *
 * `PLAN_ONCE` is the divergent half: the child builds its plan BEFORE the
 * barrier, so it goes on applying a plan that stopped describing the repo the
 * moment the parent staged a second plugin.
 *
 * `CHURN_PATH` deletes one projected skill link before each pass, so every round
 * has both writers CREATING that link rather than finding it already right. It
 * is the shape J-09 stages by hand ("a skill link deleted"), and without it only
 * the first round of a run ever reaches `symlinkSync` at all — which is why the
 * EEXIST crash this journey found showed up once and then hid.
 *
 * Every parameter arrives through the environment, so nothing is interpolated
 * into the program text.
 */
const WRITER_SOURCE = `
const { existsSync, lstatSync, rmSync, writeFileSync } = await import('node:fs');
const { project } = await import(process.env.ENGINE_URL);
const { applyPlan } = await import(process.env.APPLY_URL);
const repo = process.env.REPO_PATH;
const opts = { dorkHome: process.env.DORK_HOME };
const planOnce = process.env.PLAN_ONCE === '1';
let held = planOnce ? project(repo, opts) : null;
writeFileSync(process.env.READY_PATH, 'ready');
const deadline = Date.now() + Number(process.env.BARRIER_TIMEOUT_MS ?? 30000);
while (!existsSync(process.env.BARRIER_PATH)) {
  if (Date.now() > deadline) throw new Error('the barrier never opened');
}
const churn = process.env.CHURN_PATH;
let assumeLinkOnce = process.env.CHURN_ASSUME_LINK_ONCE === '1';
function removeProjectedLinkForChurn(path) {
  const deadline = Date.now() + 1000;
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      const isLink = assumeLinkOnce || lstatSync(path).isSymbolicLink();
      assumeLinkOnce = false;
      if (!isLink) {
        if (Date.now() > deadline) throw new Error('the churn path remained a real directory');
        Atomics.wait(sleep, 0, 0, 5);
        continue;
      }
      rmSync(path, { force: true });
      return;
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      // A second Windows writer can expose the directory it creates before it
      // finishes marking that entry as a junction. Never recurse into it: wait
      // until it is a link, then remove only the link itself.
      if (
        error?.code !== 'ERR_FS_EISDIR' &&
        error?.code !== 'EISDIR' &&
        error?.code !== 'EPERM'
      )
        throw error;
      if (Date.now() > deadline) throw error;
      Atomics.wait(sleep, 0, 0, 5);
    }
  }
}
const start = Date.now();
for (let i = 0; i < Number(process.env.ROUNDS); i++) {
  if (churn) removeProjectedLinkForChurn(churn);
  applyPlan(repo, held ?? project(repo, opts), { sweepOrphans: process.env.SWEEP === '1' });
}
writeFileSync(process.env.DONE_PATH, JSON.stringify({ start, end: Date.now() }));
`;

const temps: string[] = [];
const activeWriters: Writer[] = [];

async function cleanupOwnedFixtures(): Promise<void> {
  await settleWriters(activeWriters.splice(0));
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
}

afterEach(cleanupOwnedFixtures);

/** A fresh temp directory that is cleaned up after the test. */
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

/**
 * How many slash commands each staged plugin ships.
 *
 * Not decoration. A command projects as a generated wrapper into
 * `.claude/commands/<pkg>/` and `.opencode/commands/`, which are the two
 * directories the engine sweeps BY WILDCARD — so they are the only place a
 * concurrent writer's temp file is visible to another process's sweep. Every
 * concurrency fixture in this suite used to stage `layers: ['skills','hooks']`
 * and nothing else, which is exactly why the race below was green while the
 * engine was deleting its own in-flight writes (DOR-1854, review round 2).
 * Forty widens the window enough that the failure is not a coin flip.
 */
const COMMANDS_PER_PLUGIN = 40;

/** Write one plugin's manifest, hook, skill and commands into a repo's `.dork/plugins`. */
function stagePlugin(repo: string, name: string): void {
  const plugin = join(repo, '.dork', 'plugins', name);
  writeJsonAt(join(plugin, '.dork', 'manifest.json'), {
    schemaVersion: 1,
    name,
    version: '1.0.0',
    type: 'plugin',
    description: `the ${name} plugin`,
    layers: ['skills', 'hooks', 'commands'],
  });
  writeJsonAt(join(plugin, 'hooks', 'hooks.json'), {
    Stop: [{ hooks: [{ type: 'command', command: `echo ${name}` }] }],
  });
  writeFileAt(
    join(plugin, 'skills', `${name}-helper`, 'SKILL.md'),
    `---\nname: ${name}-helper\ndescription: helps with ${name}\n---\n\n# ${name}\n`
  );
  for (let i = 0; i < COMMANDS_PER_PLUGIN; i++) {
    writeFileAt(
      join(plugin, 'commands', `task-${i}.md`),
      `---\ndescription: ${name} task ${i}\n---\n\nDo ${name} task ${i}.\n`
    );
  }
}

/**
 * A repo that syncs to Claude Code and Codex, with two authored skills and the
 * named plugins installed.
 */
function stageRepo(prefix: string, plugins: string[]): { repo: string; dorkHome: string } {
  const repo = makeTempDir(prefix);
  const dorkHome = makeTempDir(`${prefix}home-`);
  writeJsonAt(join(repo, '.agents', 'harness.manifest.json'), {
    version: 1,
    harnesses: ['claude-code', 'codex'],
  });
  writeFileAt(join(repo, 'AGENTS.md'), '# Project\n\nHouse rules.\n');
  for (const name of ['research', 'review']) {
    writeFileAt(
      join(repo, '.agents', 'skills', name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: the ${name} skill\n---\n\n# ${name}\n`
    );
  }
  for (const name of plugins) stagePlugin(repo, name);
  return { repo, dorkHome };
}

/** The lowercase hex sha256 of a string. */
function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** When one writer was inside its apply loop. */
interface Worked {
  /** Milliseconds since the epoch when its first apply began. */
  start: number;
  /** Milliseconds since the epoch when its last apply returned. */
  end: number;
}

/**
 * Assert the two writers really were applying at the same time.
 *
 * Without this the convergence assertion is vacuous: two writers that happened
 * to run one after the other converge trivially, and a barrier that stopped
 * working would look exactly like a passing test.
 */
function expectOverlap(writers: Writer[]): void {
  const [a, b] = writers.map((w) => JSON.parse(readFileSync(w.donePath, 'utf8')) as Worked);
  expect({ overlapped: a!.start < b!.end && b!.start < a!.end }).toEqual({ overlapped: true });
}

/** One writer child, started but held at the barrier. */
interface Writer {
  /** The exact owned child, retained so a failed test can terminate only it. */
  child: ChildProcess;
  /** Resolves when the child exits, rejecting on any non-zero exit. */
  exited: Promise<void>;
  /** The file the child touches once it is at the barrier. */
  readyPath: string;
  /** The file the child touches when its last apply has landed. */
  donePath: string;
}

/** Spawn one writer child against a repo. */
function spawnWriter(control: string, label: string, env: Record<string, string>): Writer {
  const readyPath = join(control, `ready-${label}`);
  const donePath = join(control, `done-${label}`);
  const child = spawn(
    process.execPath,
    ['--import', TSX_LOADER_URL, '--input-type=module', '-e', WRITER_SOURCE],
    {
      env: {
        // eslint-disable-next-line no-restricted-syntax -- handing a child process the parent's environment, not reading a DorkOS setting
        ...process.env,
        ENGINE_URL,
        APPLY_URL,
        ROUNDS: String(ROUNDS),
        READY_PATH: readyPath,
        DONE_PATH: donePath,
        BARRIER_PATH: join(control, 'barrier'),
        ...env,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    }
  );
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`writer ${label} exited ${code}: ${stderr}`))
    );
  });
  // Attach a rejection handler immediately: a writer can fail before the test
  // reaches its explicit await, but the original promise still carries that
  // failure to the assertion.
  void exited.catch(() => undefined);
  const writer = { child, exited, readyPath, donePath };
  activeWriters.push(writer);
  return writer;
}

/** Stop any writers a failed assertion left alive, then wait until every child is gone. */
async function settleWriters(writers: Writer[]): Promise<void> {
  for (const writer of writers) {
    if (writer.child.exitCode === null && writer.child.signalCode === null) writer.child.kill();
  }
  await Promise.allSettled(writers.map((writer) => writer.exited));
}

/** Resolve once every writer has reached the barrier. */
async function waitForReady(writers: Writer[]): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!writers.every((w) => existsSync(w.readyPath))) {
    if (Date.now() > deadline) throw new Error('the writers never became ready');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Every generated hook file present in a repo, with its bytes and its sidecar's. */
function generatedPairs(repo: string): { target: string; bytes: string; sidecar?: string }[] {
  return GENERATED_HOOK_TARGETS.flatMap((target) => {
    const abs = join(repo, target);
    if (!existsSync(abs)) return [];
    const sidecarAbs = `${abs}${GENERATED_SIDECAR_SUFFIX}`;
    return [
      {
        target,
        bytes: readFileSync(abs, 'utf8'),
        sidecar: existsSync(sidecarAbs) ? readFileSync(sidecarAbs, 'utf8').trim() : undefined,
      },
    ];
  });
}

describe('J-12 — two writers on one repo', () => {
  it('never recursively deletes a real directory passed as the churn path', async () => {
    const { repo, dorkHome } = stageRepo('j12-safe-churn-', ['alpha']);
    const control = makeTempDir('j12-safe-churn-control-');
    const churn = join(repo, 'real-directory');
    mkdirSync(churn, { recursive: true });
    writeFileSync(join(churn, 'occupant'), 'owned fixture\n');
    const writer = spawnWriter(control, 'safe-churn', {
      REPO_PATH: repo,
      DORK_HOME: dorkHome,
      SWEEP: '0',
      ROUNDS: '1',
      CHURN_PATH: churn,
      CHURN_ASSUME_LINK_ONCE: '1',
    });
    await waitForReady([writer]);
    writeFileSync(join(control, 'barrier'), 'go');

    await expect(writer.exited).rejects.toThrow(/churn path remained a real directory/);

    expect(readFileSync(join(churn, 'occupant'), 'utf8')).toBe('owned fixture\n');
  });

  it('settles an owned writer still waiting at the barrier before fixture cleanup', async () => {
    const { repo, dorkHome } = stageRepo('j12-cleanup-', ['alpha']);
    const control = makeTempDir('j12-cleanup-control-');
    const writer = spawnWriter(control, 'held', {
      REPO_PATH: repo,
      DORK_HOME: dorkHome,
      SWEEP: '0',
      BARRIER_TIMEOUT_MS: '1000',
    });
    await waitForReady([writer]);
    expect({
      exitCode: writer.child.exitCode,
      signalCode: writer.child.signalCode,
      killed: writer.child.killed,
    }).toEqual({ exitCode: null, signalCode: null, killed: false });

    await cleanupOwnedFixtures();

    await expect(writer.exited).rejects.toThrow(/writer held exited/);
    expect(writer.child.killed).toBe(true);
    expect(writer.child.exitCode !== null || writer.child.signalCode !== null).toBe(true);
    expect(existsSync(repo)).toBe(false);
  });

  it('J-12, AP-10: converges on the sequential tree when both writers read the same repo', async () => {
    const { repo, dorkHome } = stageRepo('j12-race-', ['alpha', 'beta']);
    const control = makeTempDir('j12-control-');

    const writers = ['one', 'two'].map((label) =>
      spawnWriter(control, label, {
        REPO_PATH: repo,
        DORK_HOME: dorkHome,
        SWEEP: '1',
        CHURN_PATH: join(repo, '.claude', 'skills', 'research'),
      })
    );
    await waitForReady(writers);
    writeFileSync(join(control, 'barrier'), 'go');
    await Promise.all(writers.map((w) => w.exited));

    // The same repo, staged again and projected exactly once.
    const sequential = stageRepo('j12-seq-', ['alpha', 'beta']);
    const { conflicts } = applyPlan(
      sequential.repo,
      project(sequential.repo, { dorkHome: sequential.dorkHome }),
      { sweepOrphans: true }
    );
    expect(conflicts).toEqual([]);

    expectOverlap(writers);
    // Nothing is stale, nothing is blocked, nothing is orphaned.
    expect(checkPlan(repo, project(repo, { dorkHome })).clean).toBe(true);
    expect(readFileSync(join(repo, '.agents', 'skills', 'research', 'SKILL.md'), 'utf8')).toContain(
      '# research'
    );
    // …and the tree is the one a single sync leaves, path for path and byte for byte.
    expect(scrubbedSnapshot(repo)).toEqual(scrubbedSnapshot(sequential.repo));

    // Every ownership sidecar still describes the file it sits beside — the pair
    // that makes the difference between "the engine's file" and "somebody's".
    const pairs = generatedPairs(repo);
    expect(pairs.map((p) => p.target)).toEqual([CODEX_HOOKS_TARGET]);
    for (const pair of pairs) {
      expect({ target: pair.target, matches: pair.sidecar === sha256(pair.bytes) }).toEqual({
        target: pair.target,
        matches: true,
      });
    }
  }, 120_000);

  it('J-12, AP-10: never leaves a generated file holding a version nobody wrote', async () => {
    // One plugin to start with, so a writer that plans NOW and a writer that
    // plans in a moment disagree about what belongs in the file.
    const { repo, dorkHome } = stageRepo('j12-diverge-', ['alpha']);
    const control = makeTempDir('j12-diverge-control-');
    const codexHooks = join(repo, CODEX_HOOKS_TARGET);

    // The two complete versions, captured by producing each one for real in this
    // very repo, so the absolute paths inside them are the ones the race writes.
    applyPlan(repo, project(repo, { dorkHome }), { sweepOrphans: true });
    const alphaOnly = readFileSync(codexHooks, 'utf8');
    stagePlugin(repo, 'beta');
    applyPlan(repo, project(repo, { dorkHome }), { sweepOrphans: true });
    const bothPlugins = readFileSync(codexHooks, 'utf8');
    expect(alphaOnly).not.toBe(bothPlugins);

    // Back to one plugin, so the stale writer's plan is genuinely stale again.
    rmSync(join(repo, '.dork', 'plugins', 'beta'), { recursive: true, force: true });
    applyPlan(repo, project(repo, { dorkHome }), { sweepOrphans: true });

    // The stale writer plans before the barrier and then applies that plan
    // throughout; the current writer re-plans every round. The sweep stays OFF
    // here: a plan built for one plugin would prune the other's projections, and
    // this half is about the bytes in one file, not about the sweep.
    const stale = spawnWriter(control, 'stale', {
      REPO_PATH: repo,
      DORK_HOME: dorkHome,
      PLAN_ONCE: '1',
      SWEEP: '0',
    });
    await waitForReady([stale]);
    stagePlugin(repo, 'beta');
    const current = spawnWriter(control, 'current', {
      REPO_PATH: repo,
      DORK_HOME: dorkHome,
      SWEEP: '0',
    });
    await waitForReady([current]);
    writeFileSync(join(control, 'barrier'), 'go');

    // The parent is the reader: a tight synchronous poll for as long as the two
    // writers are running.
    const observed = new Map<string, number>();
    let missing = 0;
    const deadline = Date.now() + 60_000;
    while (!(existsSync(stale.donePath) && existsSync(current.donePath))) {
      if (Date.now() > deadline) throw new Error('the writers never finished');
      for (let i = 0; i < 64; i++) {
        try {
          const bytes = readFileSync(codexHooks, 'utf8');
          observed.set(bytes, (observed.get(bytes) ?? 0) + 1);
        } catch {
          missing++;
        }
      }
    }
    await Promise.all([stale.exited, current.exited]);

    expectOverlap([stale, current]);
    expect(observed.size).toBeGreaterThan(0);
    // Rename replaces the file rather than emptying and refilling it, so a reader
    // never finds the path unoccupied either.
    expect({ missing }).toEqual({ missing: 0 });

    const strangers = [...observed.keys()]
      .filter((bytes) => bytes !== alphaOnly && bytes !== bothPlugins)
      .map((bytes) => `${bytes.length} bytes: ${JSON.stringify(bytes.slice(0, 60))}…`);
    expect(
      strangers,
      `A reader polling ${CODEX_HOOKS_TARGET} through the race saw ${strangers.length} ` +
        `version(s) that neither writer ever wrote whole (${alphaOnly.length} bytes with one ` +
        `plugin, ${bothPlugins.length} with two). Anything else is a write caught in progress — ` +
        `the bytes a Codex session would have loaded.`
    ).toEqual([]);
    // …and it really watched the file change hands rather than sampling one
    // steady state, so the clean result is not an idle reader.
    expect([...observed.keys()].sort()).toEqual([alphaOnly, bothPlugins].sort());
  }, 120_000);
});
