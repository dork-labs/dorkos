/**
 * The process token port (DOR-5264): a runtime says when a process that holds
 * an identity token starts for a chat, and when it ends, and the space side
 * decides what that token may then say about its chat. The runtime never
 * learns what the space side does with it, and imports nothing from it.
 *
 * Wired once at startup by a composition step (`startup/steps/work-graph.ts`),
 * the way the turn port's facts sink is. Until then, and in any process that
 * composes none, both calls do nothing, which fails closed: a token no
 * provider was told about names no chat, so a capability that needs one
 * refuses. An `ended` for an environment no provider knows is a no-op too.
 *
 * C18 (DOR-5278, spec `computer-side-starts-alone` §5.3) replaces the provider
 * behind this port with the per-run token the space side mints and hands with
 * a run's start. The calls the runtimes make here stay where they are.
 *
 * @module services/runtimes/shared/references/process-token-port
 */

/** A process's environment, as the runtime launched it. Only its identity token is read. */
export type ProcessEnv = Readonly<Record<string, string | undefined>> | undefined;

/** What the space side provides. */
export interface ProcessTokenPort {
  /** A process launched with `env` has started for `chatId`. */
  processStarted(env: ProcessEnv, chatId: string): void;
  /** A process launched with `env` has ended. */
  processEnded(env: ProcessEnv): void;
}

let provider: ProcessTokenPort | undefined;

/**
 * Install (or clear) the provider. Called once by the composition step.
 *
 * @param next - The provider, or `undefined` to clear it.
 */
export function setProcessTokenPort(next: ProcessTokenPort | undefined): void {
  provider = next;
}

/**
 * A process launched with `env` has started for `chatId`. Never throws.
 *
 * @param env - The environment the process is launched with.
 * @param chatId - The chat it runs.
 */
export function processStarted(env: ProcessEnv, chatId: string): void {
  try {
    provider?.processStarted(env, chatId);
  } catch {
    // A token that could not be told about names no chat: the reader refuses.
  }
}

/**
 * A process launched with `env` has ended. Never throws.
 *
 * @param env - The environment the ended process was launched with.
 */
export function processEnded(env: ProcessEnv): void {
  try {
    provider?.processEnded(env);
  } catch {
    // Nothing a process's end could not give back widens anything.
  }
}
