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
  globSync,
  lstatSync,
  openSync,
  readSync,
  closeSync,
  realpathSync,
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

/** Prove successful transitive server prerequisites from the fresh ordinary Turbo summary. */
export function completedServerDependencies(summary: Json, root?: string): Json[] | null {
  try {
    if (summary.turboVersion !== '2.10.13' || summary.version !== '1' || !serverSelected(summary))
      return null;
    const rows = new Map<string, Json>(
      summary.tasks.map((task: Json): [string, Json] => [task.taskId, task])
    );
    const server = rows.get(SERVER_TASK);
    if (
      !server ||
      server.directory !== 'apps/server' ||
      !Array.isArray(server.dependencies) ||
      !server.dependencies.length ||
      !Array.isArray(server.resolvedTaskDefinition?.dependsOn) ||
      !server.resolvedTaskDefinition.dependsOn.includes('^build')
    )
      return null;
    const metadata = new Set<string>();
    const virtualDirectories = new Set<string>();
    let packages: Map<string, Json> | undefined;
    let config: Json | undefined;
    function virtual(id: string): Json {
      if (!root) throw new Error('missing virtual prerequisite proof');
      if (!packages) {
        const workspace = readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
        if (workspace.trim() !== "packages:\n  - 'apps/*'\n  - 'packages/*'")
          throw new Error('unsupported workspace graph');
        metadata.add('pnpm-workspace.yaml');
        metadata.add('turbo.json');
        config = JSON.parse(readFileSync(path.join(root, 'turbo.json'), 'utf8'));
        packages = new Map();
        for (const file of globSync(['apps/*/package.json', 'packages/*/package.json'], {
          cwd: root,
        })) {
          const manifest = JSON.parse(readFileSync(path.join(root, file), 'utf8'));
          if (typeof manifest.name !== 'string' || packages.has(manifest.name))
            throw new Error('unproved workspace package identity');
          metadata.add(file);
          packages.set(manifest.name, { manifest, directory: path.dirname(file) });
        }
      }
      const split = id.lastIndexOf('#');
      const name = id.slice(0, split);
      const taskName = id.slice(split + 1);
      const pkg = packages.get(name);
      if (
        split < 1 ||
        !pkg ||
        !['build', 'generate:api-docs'].includes(taskName) ||
        existsSync(path.join(root, pkg.directory, 'turbo.json')) ||
        existsSync(path.join(root, pkg.directory, 'turbo.jsonc')) ||
        config?.tasks?.[id] ||
        Object.hasOwn(pkg.manifest.scripts ?? {}, taskName)
      )
        throw new Error('missing executable or overridden prerequisite');
      virtualDirectories.add(pkg.directory);
      const definition = config?.tasks?.[taskName];
      if (
        !definition ||
        definition.persistent ||
        definition.with ||
        JSON.stringify(definition.dependsOn ?? []) !==
          JSON.stringify(taskName === 'build' ? ['generate:api-docs', '^build'] : [])
      )
        throw new Error('unsupported virtual prerequisite definition');
      const deps = taskName === 'build' ? [`${name}#generate:api-docs`] : [];
      if (taskName === 'build') {
        for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
          for (const [dependency, version] of Object.entries(pkg.manifest[field] ?? {})) {
            if (!packages.has(dependency)) {
              if (typeof version === 'string' && version.startsWith('workspace:'))
                throw new Error('unresolved workspace prerequisite');
              continue;
            }
            if (
              typeof version !== 'string' ||
              !['workspace:*', 'workspace:^', 'workspace:~'].includes(version)
            )
              throw new Error('unsupported workspace dependency resolution');
            deps.push(`${dependency}#build`);
          }
        }
      }
      return { taskId: id, dependencies: [...new Set(deps)], virtual: true };
    }
    const visited = new Set<string>();
    const active = new Set<string>();
    const dependencies: Json[] = [];
    function visit(id: string): void {
      if (active.has(id)) throw new Error('cyclic prerequisite graph');
      if (visited.has(id)) return;
      const task = rows.get(id) ?? virtual(id);
      if (task.virtual) {
        active.add(id);
        for (const dependency of task.dependencies) visit(dependency);
        active.delete(id);
        visited.add(id);
        return;
      }
      if (
        !task ||
        task.task === 'test' ||
        typeof task.command !== 'string' ||
        !task.command ||
        !Array.isArray(task.dependencies) ||
        task.dependencies.some((dep: unknown) => typeof dep !== 'string') ||
        !Array.isArray(task.with) ||
        task.with.length ||
        task.execution?.exitCode !== 0 ||
        task.execution.error ||
        !Number.isFinite(task.execution.startTime) ||
        !Number.isFinite(task.execution.endTime) ||
        task.execution.endTime < task.execution.startTime ||
        !['HIT', 'MISS'].includes(task.cache?.status) ||
        typeof task.hash !== 'string' ||
        !task.hash ||
        !Array.isArray(task.expandedOutputs)
      )
        throw new Error('unproved prerequisite completion');
      active.add(id);
      for (const dependency of task.dependencies) visit(dependency);
      active.delete(id);
      visited.add(id);
      dependencies.push(task);
    }
    for (const id of server.dependencies) {
      if (typeof id !== 'string') return null;
      visit(id);
    }
    if (metadata.size)
      dependencies.push({
        taskId: '$virtual-prerequisite-proof',
        directory: '.',
        outputs: [],
        excludedOutputs: [],
        expandedOutputs: [...metadata].sort(),
        metadata: true,
        virtualDirectories: [...virtualDirectories].sort(),
      });
    return dependencies.sort((a, b) => a.taskId.localeCompare(b.taskId));
  } catch {
    return null;
  }
}

/** Snapshot only recorded prerequisite outputs, including declared-glob membership and full file bodies. */
export function dependencyOutputSnapshot(root: string, tasks: Json[]): Json[] {
  if (realpathSync(root) !== path.resolve(root)) throw new Error('unproved repository root');
  const files = new Set<string>();
  const safe = (value: unknown): string => {
    if (
      typeof value !== 'string' ||
      !value ||
      path.isAbsolute(value) ||
      value.split(/[\\/]/).includes('..')
    )
      throw new Error('unsafe prerequisite output path');
    return value;
  };
  for (const task of tasks) {
    const directory = safe(task.directory);
    const cwd = path.join(root, directory);
    if (
      realpathSync(cwd) !== path.resolve(root) &&
      !realpathSync(cwd).startsWith(path.resolve(root) + path.sep)
    )
      throw new Error('external prerequisite directory');
    if (lstatSync(cwd).isSymbolicLink() || !lstatSync(cwd).isDirectory())
      throw new Error('unproved prerequisite output directory');
    if (task.outputs !== null && !Array.isArray(task.outputs))
      throw new Error('missing declared outputs');
    if (task.excludedOutputs !== null && !Array.isArray(task.excludedOutputs))
      throw new Error('missing excluded outputs');
    if (
      task.metadata &&
      task.virtualDirectories.some(
        (directory: string) =>
          existsSync(path.join(root, directory, 'turbo.json')) ||
          existsSync(path.join(root, directory, 'turbo.jsonc'))
      )
    )
      throw new Error('changed virtual prerequisite configuration');
    if (
      task.metadata &&
      JSON.stringify(
        globSync(['apps/*/package.json', 'packages/*/package.json'], { cwd: root }).sort()
      ) !==
        JSON.stringify(
          task.expandedOutputs.filter((file: string) => file.endsWith('/package.json')).sort()
        )
    )
      throw new Error('changed workspace manifest membership');
    const patterns = (task.outputs ?? []).map(safe);
    const excluded = (task.excludedOutputs ?? []).map(safe);
    const recorded = new Set<string>(task.expandedOutputs.map(safe));
    if (recorded.size !== task.expandedOutputs.length)
      throw new Error('duplicate recorded outputs');
    for (const entry of globSync(patterns, { cwd, exclude: excluded })) {
      const relative = path.join(directory, entry);
      const info = lstatSync(path.join(root, relative));
      if (info.isSymbolicLink()) throw new Error('symlink prerequisite output');
      if (info.isFile() && !recorded.has(relative))
        throw new Error('changed prerequisite output membership');
    }
    for (const entry of recorded) {
      const relative = path.relative(cwd, path.join(root, entry));
      if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative))
        throw new Error('output outside prerequisite package');
      files.add(entry);
    }
  }
  return [...files].sort().map((relative) => {
    const file = path.join(root, relative);
    const info = lstatSync(file);
    if (!realpathSync(file).startsWith(path.resolve(root) + path.sep))
      throw new Error('external prerequisite output');
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()))
      throw new Error('missing regular prerequisite output');
    if (info.isDirectory())
      return {
        path: relative,
        mode: info.mode & 0o777,
        directory: true,
        members: readdirSync(file).sort(),
      };
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(65536);
    const fd = openSync(file, 'r');
    try {
      let count: number;
      while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0)
        digest.update(buffer.subarray(0, count));
    } finally {
      closeSync(fd);
    }
    return {
      path: relative,
      bytes: info.size,
      mode: info.mode & 0o777,
      sha256: digest.digest('hex'),
    };
  });
}

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
