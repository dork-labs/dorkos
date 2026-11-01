/**
 * Types for `heavy-turbo-slot.mjs`, the turbo task `//#heavy-slot` that takes a
 * host-wide heavy-run slot for a bare `turbo` run (DOR-3274 Phase 2).
 *
 * @module scripts/heavy-turbo-slot
 */

/**
 * True when this run must not take a slot: CI, `DORKOS_HEAVY_LOCK=0`, a parent
 * that already holds one, or Windows.
 *
 * @param env - The task's environment.
 * @param platform - `process.platform`, by default.
 */
export function exempt(env: Record<string, string | undefined>, platform?: string): boolean;

/**
 * Task names turbo.json marks persistent, without any `pkg#` prefix.
 *
 * @param turboJson - The parsed turbo.json.
 */
export function persistentTasks(turboJson: {
  tasks?: Record<string, { persistent?: boolean }>;
}): string[];

/**
 * True for a turbo command line that runs until stopped: `turbo watch …`, or
 * one naming a persistent task.
 *
 * @param args - The turbo process's command line, executable first.
 * @param persistent - Persistent task names, from `persistentTasks`.
 */
export function longLived(args: string, persistent: string[]): boolean;

/**
 * The nearest ancestor whose executable is turbo, or null.
 *
 * @param startPid - The pid to start from (this task's parent).
 * @param ps - Reads one `ps -o <field>=` value for a pid.
 */
export function findTurbo(
  startPid: number,
  ps: (field: 'comm' | 'ppid' | 'args', pid: number) => string
): { pid: number; args: string } | null;
