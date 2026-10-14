import {
  serverSelected,
  completedServerDependencies,
  dependencyOutputSnapshot,
  NATIVE_FILES,
  nativeSelection,
  validateNative,
  validateIsolated,
  mergeReports,
} from './cold-shard-dependencies.ts';
export {
  serverSelected,
  completedServerDependencies,
  dependencyOutputSnapshot,
  NATIVE_FILES,
  nativeSelection,
  validateNative,
  mergeReports,
} from './cold-shard-dependencies.ts';
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Runtime report schemas are checked before their fields are composed.
type Json = Record<string, any>;

/** Reuse proved outputs for this isolated command only; otherwise retain its original dependency graph. */
export function isolatedCommand(
  command: string[],
  root: string,
  tasks: Json[] | null,
  outputs: Json[] | null
): string[] {
  if (tasks && outputs) {
    try {
      if (JSON.stringify(dependencyOutputSnapshot(root, tasks)) === JSON.stringify(outputs)) {
        const separator = command.indexOf('--');
        if (separator < 0 || command.includes('--only'))
          throw new Error('unexpected isolated command');
        return [...command.slice(0, separator), '--only', ...command.slice(separator)];
      }
    } catch {
      /* Unproved readiness always retains the original build dependencies. */
    }
  }
  return command;
}

/** Split the original eight-shard command into ordinary, Room, cold, checkbox and native phases without changing its flags. */
export function commands(original: string[]): {
  ordinary: string[];
  room: string[];
  cold: string[];
  checkbox: string[];
  native: string[];
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
  function isolated(file: string | readonly string[], output: string): string[] {
    const phaseFlags = flags.map((arg) =>
      arg === '--outputFile.json=vitest-shard-report.json' ? `--outputFile.json=${output}` : arg
    );
    if (!reports)
      phaseFlags.push('--reporter=default', '--reporter=json', `--outputFile.json=${output}`);
    // Same Turbo server task and environment; --only is added later solely for proved completed prerequisites.
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
      ...(typeof file === 'string' ? [file] : file),
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
      ...NATIVE_FILES.map((file) => `--exclude=${file}`),
    ],
    room: isolated(ROOM_FILE, 'vitest-room-shard-report.json'),
    cold: isolated(COLD_FILE, 'vitest-cold-shard-report.json'),
    checkbox: isolated(CHECKBOX_FILE, 'vitest-checkbox-shard-report.json'),
    native: [
      ...isolated(NATIVE_FILES, 'vitest-native-shard-report.json'),
      '--maxWorkers=1',
      '--fileParallelism=false',
    ],
    shard,
    reports,
  };
}

/** Await each selected phase and retain the first failure or unknown-selection refusal. */
export async function bothPhases(
  run: (phase: 'ordinary' | 'room' | 'cold' | 'checkbox' | 'native') => Promise<number>,
  selected: () => boolean | null
): Promise<{
  ordinary: number;
  room: number | null;
  cold: number | null;
  checkbox: number | null;
  native: number | null;
  exitCode: number;
}> {
  // A failed ordinary task is a result, never a reason to skip any isolated phase.
  const ordinary = await run('ordinary');
  const selection = selected();
  const room = selection === true ? await run('room') : null;
  const cold = selection === true ? await run('cold') : null;
  const checkbox = selection === true ? await run('checkbox') : null;
  const native = selection === true ? await run('native') : null;
  return {
    ordinary,
    room,
    cold,
    checkbox,
    native,
    exitCode: selection === null ? 86 : ordinary || room || cold || checkbox || native || 0,
  };
}

/** Require all 33 cold assertions on the owner shard and none on the other seven shards. */
export function validateCold(report: Json, shard: number, expectedPath: string): void {
  validateIsolated(report, shard, expectedPath, 33, 'cold');
}

/** Require the unchanged Room assertion on the owner shard and none on the other seven shards. */
export function validateRoom(report: Json, shard: number, expectedPath: string): void {
  validateIsolated(report, shard, expectedPath, 1, 'Room');
}

/** Require all 57 checkbox assertions on the owner shard and none on the other seven shards. */
export function validateCheckbox(report: Json, shard: number, expectedPath: string): void {
  validateIsolated(report, shard, expectedPath, 57, 'checkbox');
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
        [ROOM_FILE, COLD_FILE, CHECKBOX_FILE, ...NATIVE_FILES].some((file) =>
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
  const nativeReport = path.join(server, 'vitest-native-shard-report.json');
  const evidence = path.join(root, '.turbo', `cold-phases-${plan.shard}`);
  mkdirSync(evidence, { recursive: true });
  for (const file of [report, flake, roomReport, coldReport, checkboxReport, nativeReport])
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
  let completedDependencies: Json[] | null = null;
  let completedOutputs: Json[] | null = null;
  let ordinaryServerTask: Json | null = null;
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
      let selectedNative: string[] = [];
      if (phase === 'native') {
        try {
          selectedNative = await nativeSelection(server, plan.shard);
          save(path.join(evidence, 'native-selection.json'), {
            shard: plan.shard,
            selected: selectedNative,
            wholeFamily: NATIVE_FILES,
          });
        } catch (error) {
          console.error(error);
          protocolFailure = true;
          return 86;
        }
      }
      const before = summaries(root);
      const command =
        phase === 'ordinary'
          ? plan[phase]
          : isolatedCommand(plan[phase], root, completedDependencies, completedOutputs);
      const code = await native(command, root);
      try {
        save(path.join(evidence, `${phase}-dependency-reuse.json`), {
          only: command.includes('--only'),
          dependencyTaskIds: completedDependencies?.map((task) => task.taskId) ?? [],
        });

        const summary = newSummary(root, before);
        save(path.join(evidence, `${phase}-turbo-summary.json`), summary.report);
        if (phase === 'ordinary') {
          ordinarySummary = summary.file;
          selected = serverSelected(summary.report);
          ordinaryServerTask = selected
            ? summary.report.tasks.find((task: Json) => task.taskId === SERVER_TASK)
            : null;
          completedDependencies = completedServerDependencies(summary.report, root);
          try {
            completedOutputs = completedDependencies
              ? dependencyOutputSnapshot(root, completedDependencies)
              : null;
          } catch {
            completedDependencies = null;
            completedOutputs = null;
          }
          save(path.join(evidence, 'ordinary-completed-prerequisites.json'), {
            dependencyTaskIds: completedDependencies?.map((task) => task.taskId) ?? [],
            outputs: completedOutputs,
            qualified: completedDependencies !== null && completedOutputs !== null,
          });
          if (selected && plan.reports) {
            archive(report, 'vitest-ordinary-phase.raw.json');
            archive(flake, 'vitest-ordinary-flake.raw.json');
            const parsedOrdinaryReport: Json = JSON.parse(readFileSync(report, 'utf8'));
            ordinaryReport = parsedOrdinaryReport;
            ordinaryFlake = JSON.parse(readFileSync(flake, 'utf8'));
            if (
              parsedOrdinaryReport.testResults.some((file: Json) =>
                [ROOM_FILE, COLD_FILE, CHECKBOX_FILE, ...NATIVE_FILES].some(
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
          if (command.includes('--only')) {
            if (!ordinaryServerTask || summary.report.tasks.length !== 1)
              throw new Error('reused prerequisite phase changed the selected task graph');
            for (const field of [
              'directory',
              'command',
              'resolvedTaskDefinition',
              'envMode',
              'environmentVariables',
            ]) {
              if (JSON.stringify(tasks[0][field]) !== JSON.stringify(ordinaryServerTask[field]))
                throw new Error(
                  'reused prerequisite phase changed the original server task environment or definition'
                );
            }
          }
          const phaseReport =
            phase === 'room'
              ? roomReport
              : phase === 'cold'
                ? coldReport
                : phase === 'checkbox'
                  ? checkboxReport
                  : nativeReport;
          archive(phaseReport, `vitest-${phase}-phase.raw.json`);
          if (plan.reports) archive(flake, `vitest-${phase}-flake.raw.json`);
          const actual: Json = JSON.parse(readFileSync(phaseReport, 'utf8'));
          if (phase === 'room') validateRoom(actual, plan.shard, path.join(server, ROOM_FILE));
          else if (phase === 'cold') validateCold(actual, plan.shard, path.join(server, COLD_FILE));
          else if (phase === 'checkbox')
            validateCheckbox(actual, plan.shard, path.join(server, CHECKBOX_FILE));
          else validateNative(actual, selectedNative, server);
          if (phase === 'room') {
            roomReportBody = actual;
            if (plan.reports) roomFlake = JSON.parse(readFileSync(flake, 'utf8'));
          } else if (phase === 'cold') {
            coldReportBody = actual;
            if (plan.reports) coldFlake = JSON.parse(readFileSync(flake, 'utf8'));
          } else if (phase === 'checkbox' && plan.reports) {
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
          } else if (phase === 'native' && plan.reports) {
            const combined: Json = JSON.parse(readFileSync(report, 'utf8'));
            const previousFlake: Json = JSON.parse(
              readFileSync(path.join(server, 'vitest-combined-flake.raw.json'), 'utf8')
            );
            const actualFlake: Json = JSON.parse(readFileSync(flake, 'utf8'));
            if (
              previousFlake.cwd !== actualFlake.cwd ||
              !Array.isArray(previousFlake.flaky) ||
              !Array.isArray(actualFlake.flaky)
            )
              throw new Error('invalid or missing native phase flake metadata');
            save(report, mergeReports(combined, actual));
            save(flake, {
              cwd: actualFlake.cwd,
              flaky: [...previousFlake.flaky, ...actualFlake.flaky],
            });
          }
        }
      } catch (error) {
        console.error(error);
        protocolFailure = true;
      }
      if (phase === 'checkbox' && plan.reports && existsSync(flake))
        archive(flake, 'vitest-combined-flake.raw.json');
      if (phase === 'room' || phase === 'cold' || phase === 'checkbox')
        rmSync(flake, { force: true });
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
