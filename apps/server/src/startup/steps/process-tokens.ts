/**
 * Compose the process token port (DOR-5264): the runtimes say when a process
 * holding an identity token starts and ends
 * (`services/runtimes/shared/references/process-token-port.ts`), and the
 * space side's agent identity decides which chat that token then names. Wired
 * here, in a composition step, so no runtime file imports agent identity (the
 * computer wall, spec `computer-side-starts-alone` §4). C18 (DOR-5278)
 * replaces the provider wired here with its per-run token.
 *
 * @module startup/steps/process-tokens
 */
import {
  forgetTokenChatOf,
  holdTokenChatOf,
} from '../../services/core/agent-identity/agent-token-env.js';
import { setProcessTokenPort } from '../../services/runtimes/shared/references/process-token-port.js';

/** Give the runtimes' process token port its provider: agent identity's token-to-chat map. */
export function wireProcessTokenPort(): void {
  setProcessTokenPort({ processStarted: holdTokenChatOf, processEnded: forgetTokenChatOf });
}
