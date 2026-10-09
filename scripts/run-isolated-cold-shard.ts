/** Keep real Room, cold-import and checkbox recovery files behind completed ordinary task work. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  appendFileSync,
  copyFileSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const COLD_FILE =
  'src/services/canvas/doc-channel/writes/__tests__/reservation-bridge.test.ts';
export const ROOM_FILE =
  'src/services/canvas/doc-channel/__tests__/original-reviewed-room-replay.test.ts';
export const CHECKBOX_FILE =
  'src/services/canvas/doc-channel/writes/__tests__/checkbox-service.test.ts';
const SERVER_TASK = '@dorkos/server#test';
const COUNTERS = [
  'numTotalTestSuites',
  'numPassedTestSuites',
  'numFailedTestSuites',
  'numPendingTestSuites',
  'numTotalTests',
  'numPassedTests',
  'numFailedTests',
  'numPendingTests',
  'numTodoTests',
];
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Runtime report schemas are checked before their fields are composed.
type Json = Record<string, any>;

/** Validate the original Turbo task census and identify an affected server test task. */
export function serverSelected(summary: Json): boolean {
  if (!Array.isArray(summary.tasks)) throw new Error('missing original turbo task selection');
  if (
    summary.tasks.some(
      (task: Json) =>
        !task ||
        typeof task.task !== 'string' ||
        !task.task ||
        typeof task.taskId !== 'string' ||
        !task.taskId.endsWith(`#${task.task}`)
    ) ||
    new Set(summary.tasks.map((task: Json) => task.taskId)).size !== summary.tasks.length
  )
    throw new Error('malformed or duplicate original turbo task selection');
  return summary.tasks.some((task: Json) => task.task === 'test' && task.taskId === SERVER_TASK);
}

/** Split the original eight-shard command into ordinary, Room, cold and checkbox phases without changing its flags. */
export function commands(original: string[]): {
  ordinary: string[];
  room: string[];
  cold: string[];
  checkbox: string[];
  shard: number;
  reports: boolean;
} {
  const separator = original.indexOf('--');
  if (separator < 0 || original.slice(0, 4).join(' ') !== 'pnpm exec turbo test')
    throw new Error('expected original turbo test command');
  const flags = original.slice(separator + 1);
  const shards = flags.filter((arg) => arg.startsWith('--shard='));
  const shard = Number(/^--shard=([1-8])\/8$/.exec(shards[0] ?? '')?.[1]);
  if (
    shards.length !== 1 ||
    !shard ||
    !flags.includes('--passWithNoTests') ||
    !flags.includes('--run')
  )
    throw new Error('expected original eight-way Vitest run');
  if (flags.some((arg) => arg.startsWith('--exclude') || arg.startsWith('--coverage')))
    throw new Error('unsupported prefiltered/coverage command');
  const reports = flags.includes('--reporter=json');
  const ordinaryPrefix = original.slice(0, separator);
  if (!ordinaryPrefix.includes('--summarize')) ordinaryPrefix.push('--summarize');
  function isolated(file: string, output: string): string[] {
    const phaseFlags = flags.map((arg) =>
      arg === '--outputFile.json=vitest-shard-report.json' ? `--outputFile.json=${output}` : arg
    );
    if (!reports)
      phaseFlags.push('--reporter=default', '--reporter=json', `--outputFile.json=${output}`);
    // Same Turbo server task: package cwd, filtered env, build dependencies and config stay intact.
    return [
      'pnpm',
      'exec',
      'turbo',
      'test',
      '--summarize',
      '--continue',
      '--concurrency=1',
      '--filter=@dorkos/server',
      '--',
      ...phaseFlags,
      file,
    ];
  }
  return {
    ordinary: [
      ...ordinaryPrefix,
      '--',
      ...flags,
      `--exclude=${ROOM_FILE}`,
      `--exclude=${COLD_FILE}`,
      `--exclude=${CHECKBOX_FILE}`,
    ],
    room: isolated(ROOM_FILE, 'vitest-room-shard-report.json'),
    cold: isolated(COLD_FILE, 'vitest-cold-shard-report.json'),
    checkbox: isolated(CHECKBOX_FILE, 'vitest-checkbox-shard-report.json'),
    shard,
    reports,
  };
}

/** Await each selected phase and retain the first failure or unknown-selection refusal. */
export async function bothPhases(
  run: (phase: 'ordinary' | 'room' | 'cold' | 'checkbox') => Promise<number>,
  selected: () => boolean | null
): Promise<{
  ordinary: number;
  room: number | null;
  cold: number | null;
  checkbox: number | null;
  exitCode: number;
}> {
  // A failed ordinary task is a result, never a reason to skip any isolated phase.
  const ordinary = await run('ordinary');
  const selection = selected();
  const room = selection === true ? await run('room') : null;
  const cold = selection === true ? await run('cold') : null;
  const checkbox = selection === true ? await run('checkbox') : null;
  return {
    ordinary,
    room,
    cold,
    checkbox,
    exitCode: selection === null ? 86 : ordinary || room || cold || checkbox || 0,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Snapshot metadata is recursively type-checked; unknown unequal values fail closed.
function combineMetadata(a: any, b: any): any {
  if (typeof a === 'number' && typeof b === 'number') return a + b;
  if (typeof a === 'boolean' && typeof b === 'boolean') return a || b;
  if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    if (Object.keys(a).sort().join('|') !== Object.keys(b).sort().join('|'))
      throw new Error('phase metadata schema mismatch');
    return Object.fromEntries(Object.keys(a).map((key) => [key, combineMetadata(a[key], b[key])]));
  }
  if (a === b) return a;
  throw new Error('unmergeable phase metadata');
}

/** Merge disjoint native phase reports while retaining assertion results and shared metadata. */
export function mergeReports(ordinary: Json, cold: Json): Json {
  if (!Array.isArray(ordinary.testResults) || !Array.isArray(cold.testResults))
    throw new Error('missing real phase test results');
  const names = [...ordinary.testResults, ...cold.testResults].map((file: Json) => file.name);
  if (names.some((name) => typeof name !== 'string') || new Set(names).size !== names.length)
    throw new Error('duplicate phase file');
  if (Object.keys(ordinary).sort().join('|') !== Object.keys(cold).sort().join('|'))
    throw new Error('phase report schema mismatch');
  const merged: Json = { ...ordinary };
  for (const key of COUNTERS) {
    if (
      !Number.isInteger(ordinary[key]) ||
      !Number.isInteger(cold[key]) ||
      ordinary[key] < 0 ||
      cold[key] < 0
    )
      throw new Error(`invalid ${key}`);
    merged[key] = ordinary[key] + cold[key];
  }
  if (typeof ordinary.success !== 'boolean' || typeof cold.success !== 'boolean')
    throw new Error('missing phase success status');
  merged.success = ordinary.success && cold.success;
  merged.startTime = Math.min(ordinary.startTime, cold.startTime);
  merged.testResults = [...ordinary.testResults, ...cold.testResults];
  merged.snapshot = combineMetadata(ordinary.snapshot, cold.snapshot);
  if (
    (ordinary.coverageMap && Object.keys(ordinary.coverageMap).length) ||
    (cold.coverageMap && Object.keys(cold.coverageMap).length)
  )
    throw new Error('coverage needs its own supported merge; this workflow runs no coverage');
  // Retain any other original JSON metadata exactly, rather than silently discarding it.
  for (const key of Object.keys(ordinary)) {
    if (
      !COUNTERS.includes(key) &&
      !['success', 'startTime', 'testResults', 'snapshot', 'coverageMap'].includes(key) &&
      JSON.stringify(ordinary[key]) !== JSON.stringify(cold[key])
    )
      throw new Error(`unknown differing report field ${key}`);
  }
  return merged;
}

function validateIsolated(
  report: Json,
  shard: number,
  expectedPath: string,
  count: number,
  label: string
): void {
  if (!Array.isArray(report.testResults)) throw new Error(`${label} phase did not write a report`);
  const expected = shard === 1 ? [expectedPath] : [];
  if (
    JSON.stringify(report.testResults.map((file: Json) => file.name)) !== JSON.stringify(expected)
  )
    throw new Error(`${label} phase did not collect its exact singleton shard`);
  const assertions = report.testResults.flatMap((file: Json) => file.assertionResults ?? []);
  if (
    assertions.length !== (shard === 1 ? count : 0) ||
    assertions.some((assertion: Json) => !['passed', 'failed'].includes(assertion.status))
  ) {
    throw new Error(`${label} phase did not execute all original assertions`);
  }
  if (
    report.numPendingTests !== 0 ||
    report.numTodoTests !== 0 ||
    report.numPassedTests !==
      assertions.filter((assertion: Json) => assertion.status === 'passed').length ||
    report.numFailedTests !==
      assertions.filter((assertion: Json) => assertion.status === 'failed').length
  )
    throw new Error(`${label} phase assertion status accounting is inconsistent`);
  if (report.numTotalTests !== (shard === 1 ? count : 0))
    throw new Error(`${label} whole-file assertions changed or were not executed`);
}

/** Require all 33 cold assertions on the owner shard and none on the other seven shards. */
export function validateCold(report: Json, shard: number, expectedPath: string): void {
  validateIsolated(report, shard, expectedPath, 33, 'cold');
}

/** Require the unchanged Room assertion on the owner shard and none on the other seven shards. */
export function validateRoom(report: Json, shard: number, expectedPath: string): void {
  validateIsolated(report, shard, expectedPath, 1, 'Room');
}

/** Require all 56 checkbox assertions on the owner shard and none on the other seven shards. */
export function validateCheckbox(report: Json, shard: number, expectedPath: string): void {
  validateIsolated(report, shard, expectedPath, 56, 'checkbox');
}

/** Run a child command and report its result only after the process has closed. */
export async function native(argv: string[], root: string): Promise<number> {
  const executable = argv[0];
  if (!executable) throw new Error('missing child executable');
  return new Promise((resolve) => {
    const child = spawn(executable, argv.slice(1), { cwd: root, stdio: 'inherit' });
    let failedToSpawn = false;
    child.once('error', (error) => {
      console.error(error);
      failedToSpawn = true;
    });
    child.once('close', (code) => resolve(failedToSpawn ? 1 : (code ?? 1)));
  });
}

function summaries(root: string): string[] {
  const directory = path.join(root, '.turbo/runs');
  return existsSync(directory)
    ? readdirSync(directory).filter((name) => name.endsWith('.json'))
    : [];
}
function newSummary(root: string, before: string[]): { file: string; report: Json } {
  const added = summaries(root).filter((name) => !before.includes(name));
  if (added.length !== 1) throw new Error('expected exactly one fresh original turbo summary');
  const filename = added[0];
  if (!filename) throw new Error('missing fresh original turbo summary filename');
  const file = path.join(root, '.turbo/runs', filename);
  return { file, report: JSON.parse(readFileSync(file, 'utf8')) };
}
function save(file: string, value: Json): void {
  writeFileSync(file, `${JSON.stringify(value)}\n`);
}

async function main(original: string[]): Promise<number> {
  const plan = commands(original);
  const root = process.cwd();
  // CLI exclusions reach every task. A future second package with this same
  // relative filename must fail rather than silently lose its file.
  for (const category of ['apps', 'packages']) {
    for (const directory of readdirSync(path.join(root, category), { withFileTypes: true })) {
      if (
        directory.isDirectory() &&
        `${category}/${directory.name}` !== 'apps/server' &&
        [ROOM_FILE, COLD_FILE, CHECKBOX_FILE].some((file) =>
          existsSync(path.join(root, category, directory.name, file))
        )
      )
        throw new Error('isolated exclusion collides with another package');
    }
  }
  const server = path.join(root, 'apps/server');
  const report = path.join(server, 'vitest-shard-report.json');
  const flake = path.join(server, 'vitest-flake-report.json');
  const roomReport = path.join(server, 'vitest-room-shard-report.json');
  const coldReport = path.join(server, 'vitest-cold-shard-report.json');
  const checkboxReport = path.join(server, 'vitest-checkbox-shard-report.json');
  const evidence = path.join(root, '.turbo', `cold-phases-${plan.shard}`);
  mkdirSync(evidence, { recursive: true });
  for (const file of [report, flake, roomReport, coldReport, checkboxReport])
    rmSync(file, { force: true });
  let selected: boolean | null = null; // A missing selection proof never expands affected server work.
  let protocolFailure = false;
  let ordinaryReport: Json | undefined;
  let ordinaryFlake: Json | undefined;
  let roomReportBody: Json | undefined;
  let roomFlake: Json | undefined;
  let coldReportBody: Json | undefined;
  let coldFlake: Json | undefined;
  let ordinarySummary = '';
  const archivedReports: { path: string; sha256: string; bytes: number }[] = [];
  function archive(source: string, name: string): void {
    const target = path.join(server, name);
    copyFileSync(source, target);
    const bytes = readFileSync(target);
    archivedReports.push({
      path: target,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    });
  }
  const result = await bothPhases(
    async (phase) => {
      const before = summaries(root);
      const code = await native(plan[phase], root);
      try {
        const summary = newSummary(root, before);
        save(path.join(evidence, `${phase}-turbo-summary.json`), summary.report);
        if (phase === 'ordinary') {
          ordinarySummary = summary.file;
          selected = serverSelected(summary.report);
          if (selected && plan.reports) {
            archive(report, 'vitest-ordinary-phase.raw.json');
            archive(flake, 'vitest-ordinary-flake.raw.json');
            const parsedOrdinaryReport: Json = JSON.parse(readFileSync(report, 'utf8'));
            ordinaryReport = parsedOrdinaryReport;
            ordinaryFlake = JSON.parse(readFileSync(flake, 'utf8'));
            if (
              parsedOrdinaryReport.testResults.some((file: Json) =>
                [ROOM_FILE, COLD_FILE, CHECKBOX_FILE].some(
                  (isolated) => file.name === path.join(server, isolated)
                )
              )
            )
              throw new Error('ordinary phase collected the excluded isolated file');
          }
          rmSync(flake, { force: true }); // Require a fresh isolated reporter, never an ordinary-phase leftover.
        } else {
          if (!serverSelected(summary.report)) throw new Error('isolated server task is missing');
          const tasks = summary.report.tasks.filter((task: Json) => task.task === 'test');
          if (
            tasks.length !== 1 ||
            tasks[0].taskId !== SERVER_TASK ||
            tasks[0].cache?.status !== 'MISS'
          )
            throw new Error(`${phase} task did not execute exactly once without a cache replay`);
          const phaseReport =
            phase === 'room' ? roomReport : phase === 'cold' ? coldReport : checkboxReport;
          archive(phaseReport, `vitest-${phase}-phase.raw.json`);
          if (plan.reports) archive(flake, `vitest-${phase}-flake.raw.json`);
          const actual: Json = JSON.parse(readFileSync(phaseReport, 'utf8'));
          if (phase === 'room') validateRoom(actual, plan.shard, path.join(server, ROOM_FILE));
          else if (phase === 'cold') validateCold(actual, plan.shard, path.join(server, COLD_FILE));
          else validateCheckbox(actual, plan.shard, path.join(server, CHECKBOX_FILE));
          if (phase === 'room') {
            roomReportBody = actual;
            if (plan.reports) roomFlake = JSON.parse(readFileSync(flake, 'utf8'));
          } else if (phase === 'cold') {
            coldReportBody = actual;
            if (plan.reports) coldFlake = JSON.parse(readFileSync(flake, 'utf8'));
          } else if (plan.reports) {
            const actualFlake: Json = JSON.parse(readFileSync(flake, 'utf8'));
            if (
              !ordinaryReport ||
              !roomReportBody ||
              !coldReportBody ||
              ordinaryFlake?.cwd !== actualFlake.cwd ||
              roomFlake?.cwd !== actualFlake.cwd ||
              coldFlake?.cwd !== actualFlake.cwd ||
              !Array.isArray(ordinaryFlake?.flaky) ||
              !Array.isArray(roomFlake?.flaky) ||
              !Array.isArray(coldFlake?.flaky) ||
              !Array.isArray(actualFlake.flaky)
            )
              throw new Error('invalid or missing four-phase report/flake metadata');
            save(
              report,
              mergeReports(
                mergeReports(mergeReports(ordinaryReport, roomReportBody), coldReportBody),
                actual
              )
            );
            save(flake, {
              cwd: actualFlake.cwd,
              flaky: [
                ...ordinaryFlake.flaky,
                ...roomFlake.flaky,
                ...coldFlake.flaky,
                ...actualFlake.flaky,
              ],
            });
          }
        }
      } catch (error) {
        console.error(error);
        protocolFailure = true;
      }
      if (phase === 'room' || phase === 'cold') rmSync(flake, { force: true });
      return code;
    },
    () => selected
  );
  save(path.join(evidence, 'phases.json'), {
    ...result,
    selected,
    protocolFailure,
    ordinarySummary,
    archivedReports,
  });
  // Existing full-workspace execution proof must read phase ONE, not the newest server-only summary.
  // eslint-disable-next-line no-restricted-syntax -- GitHub output is the dispatcher tool interface, not an application env input.
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) appendFileSync(githubOutput, `ordinary-summary=${ordinarySummary}\n`);
  // Malformed/missing execution evidence cannot be excused by the quarantine lane.
  return protocolFailure ? 86 : result.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const separator = process.argv.indexOf('--');
  main(process.argv.slice(separator + 1))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 86;
    });
}
