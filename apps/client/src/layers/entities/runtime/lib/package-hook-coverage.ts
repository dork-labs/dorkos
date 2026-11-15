import { SELECTABLE_RUNTIME_TYPES, getRuntimeDescriptor } from '../config/runtime-descriptors';

/** The copy a runtime with no package hooks shows wherever a person picks it. */
export const PACKAGE_HOOKS_NOT_YET = "Package safety checks don't run on this runtime yet.";

/**
 * Whether a hook does all of its work on a runtime where DorkOS runs only
 * shell checks: a `PreToolUse` hook that names `Bash` and no other tool. One
 * with no matcher, `*`, or `Bash|Edit` also guards edits on Claude Code, which
 * a shell-checks runtime cannot do, so it does not count.
 */
function isShellOnly(hook: { event: string; matcher?: string }): boolean {
  if (hook.event !== 'PreToolUse' || hook.matcher === undefined) return false;
  if (!/^[\w|]+$/.test(hook.matcher)) return false;
  return hook.matcher.split('|').every((name) => name === 'Bash');
}

/**
 * The runtimes, by label, where some of a package's hooks would not run
 * (DOR-4379). Built from each runtime's {@link RuntimeDescriptor.packageHooks},
 * so the install preview and the runtime picker say the same thing.
 *
 * @param hooks - The package's hooks, by event and matcher.
 * @returns Runtime labels in picker order; empty when every hook runs everywhere.
 */
export function runtimesMissingPackageHooks(
  hooks: readonly { event: string; matcher?: string }[]
): string[] {
  if (hooks.length === 0) return [];
  const allShellOnly = hooks.every(isShellOnly);
  return SELECTABLE_RUNTIME_TYPES.flatMap((type) => {
    const descriptor = getRuntimeDescriptor(type);
    const runs =
      descriptor.packageHooks === 'all' ||
      (descriptor.packageHooks === 'shell-checks' && allShellOnly);
    return runs ? [] : [descriptor.label];
  });
}

/**
 * Whether a runtime runs no package hooks at all, so its picker says so.
 *
 * @param type - The runtime type.
 */
export function runsNoPackageHooks(type: string): boolean {
  return getRuntimeDescriptor(type).packageHooks === 'none';
}
