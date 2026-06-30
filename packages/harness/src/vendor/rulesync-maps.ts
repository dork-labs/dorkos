/**
 * Vendored cross-agent hook-event maps and path constants from rulesync.
 *
 * This file is VENDORED STATIC DATA, transcribed verbatim from the rulesync
 * project. It is not generated and not imported from the upstream npm package;
 * we copy it in so the Harness Sync engine has a stable, audited snapshot of the
 * cross-agent translation tables. To update it, follow the re-vendor checklist
 * in `contributing/harness-sync.md`.
 *
 * Source:   https://github.com/dyoshikawa/rulesync
 * Pinned:   commit b4bf09d5 (npm rulesync@9.0.2)
 * Files:    src/types/hooks.ts, src/constants/{claudecode,codexcli,copilot,cursor}-paths.ts
 * License:  MIT
 *
 * ---------------------------------------------------------------------------
 * The MIT License (MIT)
 *
 * Copyright (c) 2024 dyoshikawa
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 * ---------------------------------------------------------------------------
 *
 * @module
 */

import { join } from 'node:path';

/**
 * All canonical hook event names.
 *
 * Each tool supports a subset of these events; the per-tool `*_HOOK_EVENTS`
 * arrays below declare which subset, and the `CANONICAL_TO_*_EVENT_NAMES` maps
 * translate the canonical camelCase name into each tool's on-disk spelling.
 */
export type HookEvent =
  | 'sessionStart'
  | 'sessionEnd'
  | 'preToolUse'
  | 'postToolUse'
  | 'preModelInvocation'
  | 'postModelInvocation'
  | 'beforeSubmitPrompt'
  | 'stop'
  | 'subagentStop'
  | 'preCompact'
  | 'postCompact'
  | 'contextOffload'
  | 'postToolUseFailure'
  | 'subagentStart'
  | 'beforeShellExecution'
  | 'afterShellExecution'
  | 'beforeMCPExecution'
  | 'afterMCPExecution'
  | 'beforeReadFile'
  | 'afterFileEdit'
  | 'beforeAgentResponse'
  | 'afterAgentResponse'
  | 'afterAgentThought'
  | 'beforeTabFileRead'
  | 'afterTabFileEdit'
  | 'permissionRequest'
  | 'notification'
  | 'setup'
  | 'afterError'
  | 'beforeToolSelection'
  | 'worktreeCreate'
  | 'worktreeRemove'
  | 'workspaceOpen'
  | 'messageDisplay'
  | 'todoCreated'
  | 'todoCompleted'
  | 'stopFailure'
  | 'instructionsLoaded'
  | 'userPromptExpansion'
  | 'postToolBatch'
  | 'permissionDenied'
  | 'taskCreated'
  | 'taskCompleted'
  | 'teammateIdle'
  | 'configChange'
  | 'cwdChanged'
  | 'fileChanged'
  | 'elicitation'
  | 'elicitationResult';

/**
 * Hook events supported by Claude Code.
 *
 * Covers the full documented event surface.
 * @see https://code.claude.com/docs/en/hooks#hook-events
 */
export const CLAUDE_HOOK_EVENTS: readonly HookEvent[] = [
  'sessionStart',
  'sessionEnd',
  'preToolUse',
  'postToolUse',
  'beforeSubmitPrompt',
  'stop',
  'subagentStop',
  'preCompact',
  'permissionRequest',
  'notification',
  'setup',
  'worktreeCreate',
  'worktreeRemove',
  'messageDisplay',
  'instructionsLoaded',
  'userPromptExpansion',
  'postToolUseFailure',
  'postToolBatch',
  'permissionDenied',
  'subagentStart',
  'taskCreated',
  'taskCompleted',
  'stopFailure',
  'teammateIdle',
  'configChange',
  'cwdChanged',
  'fileChanged',
  'postCompact',
  'elicitation',
  'elicitationResult',
];

/** Hook events supported by Codex CLI. */
export const CODEXCLI_HOOK_EVENTS: readonly HookEvent[] = [
  'sessionStart',
  'preToolUse',
  'postToolUse',
  'beforeSubmitPrompt',
  'stop',
  'permissionRequest',
  'subagentStart',
  'subagentStop',
  'preCompact',
  'postCompact',
];

/** Hook events supported by Cursor. */
export const CURSOR_HOOK_EVENTS: readonly HookEvent[] = [
  'sessionStart',
  'sessionEnd',
  'preToolUse',
  'postToolUse',
  'beforeSubmitPrompt',
  'stop',
  'subagentStop',
  'preCompact',
  'postToolUseFailure',
  'subagentStart',
  'beforeShellExecution',
  'afterShellExecution',
  'beforeMCPExecution',
  'afterMCPExecution',
  'beforeReadFile',
  'afterFileEdit',
  'afterAgentResponse',
  'afterAgentThought',
  'beforeTabFileRead',
  'afterTabFileEdit',
  'workspaceOpen',
];

/**
 * Hook events supported by GitHub Copilot (cloud coding agent).
 *
 * GitHub documents an eight-event surface for `.github/hooks/*.json`:
 * `sessionStart`, `sessionEnd`, `userPromptSubmitted` (`beforeSubmitPrompt`),
 * `preToolUse`, `postToolUse`, `agentStop` (`stop`), `subagentStop`, and
 * `errorOccurred` (`afterError`). `subagentStart` is intentionally absent: it
 * is not part of the documented cloud-agent surface.
 *
 * @see https://docs.github.com/en/copilot/concepts/agents/coding-agent/about-hooks
 */
export const COPILOT_HOOK_EVENTS: readonly HookEvent[] = [
  'sessionStart',
  'sessionEnd',
  'beforeSubmitPrompt',
  'preToolUse',
  'postToolUse',
  'stop',
  'subagentStop',
  'afterError',
];

/**
 * Hook events supported by the GitHub Copilot CLI (`copilotcli-hooks.ts`).
 *
 * The CLI documents a wider event surface than the shared cloud-agent set, so
 * `copilotcli` diverges from {@link COPILOT_HOOK_EVENTS}.
 *
 * @see https://docs.github.com/en/copilot/reference/hooks-configuration
 */
export const COPILOTCLI_HOOK_EVENTS: readonly HookEvent[] = [
  'sessionStart',
  'sessionEnd',
  'beforeSubmitPrompt',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'stop',
  'subagentStart',
  'subagentStop',
  'afterError',
  'preCompact',
  'permissionRequest',
  'notification',
];

/** Map canonical camelCase event names to Claude Code PascalCase. */
export const CANONICAL_TO_CLAUDE_EVENT_NAMES: Record<string, string> = {
  sessionStart: 'SessionStart',
  sessionEnd: 'SessionEnd',
  preToolUse: 'PreToolUse',
  postToolUse: 'PostToolUse',
  beforeSubmitPrompt: 'UserPromptSubmit',
  stop: 'Stop',
  subagentStop: 'SubagentStop',
  preCompact: 'PreCompact',
  permissionRequest: 'PermissionRequest',
  notification: 'Notification',
  setup: 'Setup',
  worktreeCreate: 'WorktreeCreate',
  worktreeRemove: 'WorktreeRemove',
  messageDisplay: 'MessageDisplay',
  instructionsLoaded: 'InstructionsLoaded',
  userPromptExpansion: 'UserPromptExpansion',
  postToolUseFailure: 'PostToolUseFailure',
  postToolBatch: 'PostToolBatch',
  permissionDenied: 'PermissionDenied',
  subagentStart: 'SubagentStart',
  taskCreated: 'TaskCreated',
  taskCompleted: 'TaskCompleted',
  stopFailure: 'StopFailure',
  teammateIdle: 'TeammateIdle',
  configChange: 'ConfigChange',
  cwdChanged: 'CwdChanged',
  fileChanged: 'FileChanged',
  postCompact: 'PostCompact',
  elicitation: 'Elicitation',
  elicitationResult: 'ElicitationResult',
};

/** Map Claude Code PascalCase event names back to canonical camelCase. */
export const CLAUDE_TO_CANONICAL_EVENT_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(CANONICAL_TO_CLAUDE_EVENT_NAMES).map(([k, v]) => [v, k])
);

/** Map canonical camelCase event names to Codex CLI PascalCase. */
export const CANONICAL_TO_CODEXCLI_EVENT_NAMES: Record<string, string> = {
  sessionStart: 'SessionStart',
  preToolUse: 'PreToolUse',
  postToolUse: 'PostToolUse',
  beforeSubmitPrompt: 'UserPromptSubmit',
  stop: 'Stop',
  permissionRequest: 'PermissionRequest',
  subagentStart: 'SubagentStart',
  subagentStop: 'SubagentStop',
  preCompact: 'PreCompact',
  postCompact: 'PostCompact',
};

/** Map Codex CLI PascalCase event names back to canonical camelCase. */
export const CODEXCLI_TO_CANONICAL_EVENT_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(CANONICAL_TO_CODEXCLI_EVENT_NAMES).map(([k, v]) => [v, k])
);

/**
 * Map canonical camelCase event names to Cursor camelCase.
 * Currently 1:1 but kept explicit so divergences are easy to add.
 */
export const CANONICAL_TO_CURSOR_EVENT_NAMES: Record<string, string> = {
  sessionStart: 'sessionStart',
  sessionEnd: 'sessionEnd',
  preToolUse: 'preToolUse',
  postToolUse: 'postToolUse',
  beforeSubmitPrompt: 'beforeSubmitPrompt',
  stop: 'stop',
  subagentStop: 'subagentStop',
  preCompact: 'preCompact',
  postToolUseFailure: 'postToolUseFailure',
  subagentStart: 'subagentStart',
  beforeShellExecution: 'beforeShellExecution',
  afterShellExecution: 'afterShellExecution',
  beforeMCPExecution: 'beforeMCPExecution',
  afterMCPExecution: 'afterMCPExecution',
  beforeReadFile: 'beforeReadFile',
  afterFileEdit: 'afterFileEdit',
  afterAgentResponse: 'afterAgentResponse',
  afterAgentThought: 'afterAgentThought',
  beforeTabFileRead: 'beforeTabFileRead',
  afterTabFileEdit: 'afterTabFileEdit',
  workspaceOpen: 'workspaceOpen',
};

/** Map Cursor camelCase event names back to canonical camelCase. */
export const CURSOR_TO_CANONICAL_EVENT_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(CANONICAL_TO_CURSOR_EVENT_NAMES).map(([k, v]) => [v, k])
);

/** Map canonical camelCase event names to GitHub Copilot (cloud agent) camelCase. */
export const CANONICAL_TO_COPILOT_EVENT_NAMES: Record<string, string> = {
  sessionStart: 'sessionStart',
  sessionEnd: 'sessionEnd',
  beforeSubmitPrompt: 'userPromptSubmitted',
  preToolUse: 'preToolUse',
  postToolUse: 'postToolUse',
  stop: 'agentStop',
  subagentStop: 'subagentStop',
  afterError: 'errorOccurred',
};

/** Map GitHub Copilot (cloud agent) camelCase event names back to canonical camelCase. */
export const COPILOT_TO_CANONICAL_EVENT_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(CANONICAL_TO_COPILOT_EVENT_NAMES).map(([k, v]) => [v, k])
);

/**
 * Map canonical camelCase event names to the GitHub Copilot CLI's wider event
 * surface.
 *
 * @see https://docs.github.com/en/copilot/reference/hooks-configuration
 */
export const CANONICAL_TO_COPILOTCLI_EVENT_NAMES: Record<string, string> = {
  sessionStart: 'sessionStart',
  sessionEnd: 'sessionEnd',
  beforeSubmitPrompt: 'userPromptSubmitted',
  preToolUse: 'preToolUse',
  postToolUse: 'postToolUse',
  postToolUseFailure: 'postToolUseFailure',
  stop: 'agentStop',
  subagentStart: 'subagentStart',
  subagentStop: 'subagentStop',
  afterError: 'errorOccurred',
  preCompact: 'preCompact',
  permissionRequest: 'permissionRequest',
  notification: 'notification',
};

/** Map GitHub Copilot CLI event names back to canonical camelCase. */
export const COPILOTCLI_TO_CANONICAL_EVENT_NAMES: Record<string, string> = Object.fromEntries(
  Object.entries(CANONICAL_TO_COPILOTCLI_EVENT_NAMES).map(([k, v]) => [v, k])
);

/**
 * Claude Code configuration-layout paths (skills, rules, hooks, commands).
 *
 * Transcribed from rulesync `src/constants/claudecode-paths.ts`. Claude Code
 * hooks live under the `hooks` key of `settings.json`.
 */
export const claudecodePaths = {
  dir: '.claude',
  ruleFileName: 'CLAUDE.md',
  localRuleFileName: 'CLAUDE.local.md',
  rulesDirName: 'rules',
  skillsDirPath: join('.claude', 'skills'),
  commandsDirPath: join('.claude', 'commands'),
  hooksFileName: 'settings.json',
} as const;

/**
 * Codex CLI configuration-layout paths (skills, rules, hooks, commands).
 *
 * Transcribed from rulesync `src/constants/codexcli-paths.ts`. Codex reads its
 * instructions from `AGENTS.md`, its skills from `.agents/skills`, and exposes
 * commands as "prompts" under `.codex/prompts`.
 */
export const codexcliPaths = {
  dir: '.codex',
  ruleFileName: 'AGENTS.md',
  skillsDirPath: join('.agents', 'skills'),
  commandsDirPath: join('.codex', 'prompts'),
  hooksFileName: 'hooks.json',
} as const;

/**
 * GitHub Copilot configuration-layout paths (skills, rules, hooks, commands).
 *
 * Transcribed from rulesync `src/constants/copilot-paths.ts`. Copilot reads
 * instructions, skills, prompts, and hooks from under `.github/`.
 */
export const copilotPaths = {
  dir: '.copilot',
  githubDir: '.github',
  ruleFileName: 'copilot-instructions.md',
  skillsDirPath: join('.github', 'skills'),
  commandsDirPath: join('.github', 'prompts'),
  hooksDirPath: join('.github', 'hooks'),
  hooksFileName: 'copilot-hooks.json',
} as const;

/**
 * Cursor configuration-layout paths (skills, rules, hooks, commands).
 *
 * Transcribed from rulesync `src/constants/cursor-paths.ts`. Cursor hooks live
 * in `.cursor/hooks.json`.
 */
export const cursorPaths = {
  dir: '.cursor',
  skillsDirPath: join('.cursor', 'skills'),
  commandsDirPath: join('.cursor', 'commands'),
  hooksFileName: 'hooks.json',
} as const;
