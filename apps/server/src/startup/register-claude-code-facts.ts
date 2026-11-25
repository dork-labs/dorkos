/**
 * Hand turn code and core the facts only the Claude Code adapter can answer, which
 * neither may import (DOR-4928): the agent-file runtime pin, the credits folder and a
 * transcript's path go to session's port, and the account folders to the protected-path
 * policy. One helper, so every boot that runs turns registers the same answers: the
 * server's (`start()` in `index.ts`) and the in-process test server's (`harness-boot.ts`),
 * each as its first step.
 *
 * @module startup/register-claude-code-facts
 */
import { setProtectedAccountRoots } from '../services/core/protected-paths/protected-path-roots.js';
import { resolveClaudeRootSet } from '../services/runtimes/claude-code/claude-config-dir.js';
import { isCreditsClaudeRoot } from '../services/runtimes/claude-code/credits-root.js';
import { runtimeUnlessHeld } from '../services/runtimes/claude-code/folder-settings/folder-config-consent.js';
import { claudeTranscriptPath } from '../services/runtimes/claude-code/sessions/project-slug.js';
import { setClaudeCodeFacts } from '../services/session/resolution/claude-code-facts.js';

/** Register Claude Code's answers. Called once per boot, before any runtime registers. */
export function registerClaudeCodeFacts(): void {
  setClaudeCodeFacts({
    runtimeUnlessHeld,
    isCreditsRoot: isCreditsClaudeRoot,
    transcriptPath: claudeTranscriptPath,
  });
  setProtectedAccountRoots(() => resolveClaudeRootSet());
}
