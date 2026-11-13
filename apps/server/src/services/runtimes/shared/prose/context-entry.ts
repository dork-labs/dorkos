/**
 * The shared prose bodies for structured context entries that every runtime
 * must present in the same words.
 *
 * These lived in the Claude Code adapter, so Codex, OpenCode and Doe fell back
 * to a JSON dump and a person's queued message reached them as
 * `{"composedDuringPrevTurn": true}` (DOR-3604).
 *
 * @module server/services/runtimes/shared/prose/context-entry
 */
import type { EnvData, GitStatusData, RelayContextData } from '@dorkos/shared/additional-context';

/** The prose inside a queue note's one-line context block. */
export const QUEUE_NOTE_TEXT = 'composed while the agent was responding to the previous message';

/**
 * Format structured {@link GitStatusData} into the `<git_status>` body lines
 * (the formatting that moved out of the old `buildGitBlock`).
 */
export function formatGitStatus(data: GitStatusData): string {
  if (!data.isRepo) return 'Is git repo: false';

  const lines: string[] = [
    'Is git repo: true',
    `Current branch: ${data.branch}`,
    'Main branch (use for PRs): main',
  ];

  if ((data.ahead ?? 0) > 0) lines.push(`Ahead of origin: ${data.ahead} commits`);
  if ((data.behind ?? 0) > 0) lines.push(`Behind origin: ${data.behind} commits`);
  if (data.detached) lines.push('Detached HEAD: true');

  if (data.clean) {
    lines.push('Working tree: clean');
  } else {
    const parts: string[] = [];
    if ((data.modified ?? 0) > 0) parts.push(`${data.modified} modified`);
    if ((data.staged ?? 0) > 0) parts.push(`${data.staged} staged`);
    if ((data.untracked ?? 0) > 0) parts.push(`${data.untracked} untracked`);
    if ((data.conflicted ?? 0) > 0) parts.push(`${data.conflicted} conflicted`);
    // `deriveGitStatus` always sets `clean` to match the counts, so this branch
    // implies at least one dirty part. Guard the empty case anyway so a partial
    // hand-built `GitStatusData` never renders a bare `dirty ()`.
    lines.push(
      parts.length > 0 ? `Working tree: dirty (${parts.join(', ')})` : 'Working tree: clean'
    );
  }

  return lines.join('\n');
}

/** Format structured {@link EnvData} into the `<env>` body lines. */
export function formatEnv(data: EnvData): string {
  return [
    `Working directory: ${data.workingDirectory}`,
    `Product: ${data.product}`,
    `Version: ${data.version}`,
    `Port: ${data.port}`,
    `Platform: ${data.platform}`,
    `OS Version: ${data.osVersion}`,
    `Node.js: ${data.nodeVersion}`,
    `Hostname: ${data.hostname}`,
  ].join('\n');
}

/** Format structured {@link RelayContextData} into the `<relay_context>` body lines. */
export function formatRelayContext(data: RelayContextData): string {
  const lines: string[] = [
    `Agent-ID: ${data.agentId}`,
    `Session-ID: ${data.sessionId}`,
    `From: ${data.from}`,
    `Message-ID: ${data.messageId}`,
    `Subject: ${data.subject}`,
    `Sent: ${data.sent}`,
  ];
  if (
    data.hopsUsed !== undefined ||
    data.ttlSecondsRemaining !== undefined ||
    data.callBudgetRemaining !== undefined
  ) {
    lines.push('', 'Budget remaining:');
    if (data.hopsUsed !== undefined && data.hopsMax !== undefined) {
      lines.push(`- Hops: ${data.hopsUsed} of ${data.hopsMax} used`);
    }
    if (data.ttlSecondsRemaining !== undefined) {
      lines.push(`- TTL: ${data.ttlSecondsRemaining} seconds remaining`);
    }
    if (data.callBudgetRemaining !== undefined) {
      lines.push(`- Max turns: ${data.callBudgetRemaining}`);
    }
  }
  if (data.replyTo) {
    lines.push(
      '',
      `Reply to: ${data.replyTo}`,
      "If you cannot complete the task within the budget, summarize what you've done and stop."
    );
  }
  return lines.join('\n');
}
