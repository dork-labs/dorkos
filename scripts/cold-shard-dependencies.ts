import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  globSync,
  lstatSync,
  openSync,
  readSync,
  closeSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';

const SERVER_TASK = '@dorkos/server#test';
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

export const NATIVE_FILES = [
  'src/routes/__tests__/sessions-cwd-resolution.test.ts',
  'src/services/rooms/__tests__/room-turn-runner.test.ts',
  'src/services/rooms/repo/__tests__/room-original-native-launch.test.ts',
  'src/services/rooms/repo/__tests__/room-worktree-refresh.integration.test.ts',
  'src/services/rooms/repo/__tests__/room-worktree-refresh.test.ts',
  'src/services/session/__tests__/message-dispatcher.test.ts',
] as const;
export const NATIVE_COUNTS = [30, 96, 10, 3, 35, 101];

export function validateIsolated(
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

/** Collect exact native files and shard them with the actual configured Vitest sequencer. */
export async function nativeSelection(server: string, shard: number): Promise<string[]> {
  const { createVitest } = await import('vitest/node');
  const context = await createVitest('test', {
    root: server,
    run: true,
    watch: false,
    shard: `${shard}/8`,
  });
  try {
    const specifications = await context.globTestSpecifications(
      NATIVE_FILES.map((file) => path.join(server, file))
    );
    const collected = specifications.map((specification) => specification.moduleId).sort();
    if (
      JSON.stringify(collected) !==
      JSON.stringify(NATIVE_FILES.map((file) => path.join(server, file)).sort())
    )
      throw new Error('native family collection differs from the exact six whole files');
    const sequencer = new context.config.sequence.sequencer(context);
    return (await sequencer.shard(specifications)).map((specification) => specification.moduleId);
  } finally {
    await context.close();
  }
}

/** Require the actually selected native whole file and every original assertion. */
export function validateNative(report: Json, selected: readonly string[], server: string): void {
  if (selected.length > 1) throw new Error('native shard selected multiple files');
  const index = selected.length
    ? NATIVE_FILES.findIndex((file) => path.join(server, file) === selected[0])
    : -1;
  if (selected.length && index < 0) throw new Error('native shard selected an unowned file');
  validateIsolated(
    report,
    selected.length ? 1 : 0,
    selected[0] ?? '',
    index < 0 ? 0 : NATIVE_COUNTS[index]!,
    'native'
  );
}

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
