/**
 * Stopping Codex's credits turns from the server's shutdown. Split out of the
 * server's `index.ts` so that file stays inside its line budget.
 *
 * @module services/runtimes/codex-credits-stop
 */
import { runtimeRegistry } from '../core/runtime-registry.js';

/**
 * Stop every Codex turn running on DorkOS credits, when Codex is registered.
 * Structural, because the Codex runtime is constructed inside an optional
 * registration and is not held here.
 */
export function stopCodexCreditsTurns(): void {
  const codex = runtimeRegistry.listRuntimes().find((runtime) => runtime.type === 'codex') as
    { stopCreditsTurns?: () => void } | undefined;
  codex?.stopCreditsTurns?.();
}
