import os from 'node:os';
import { getGitStatus } from './git-status.js';
import type { GitStatusResponse } from '@dorkos/shared/types';
import { logger } from '../../lib/logger.js';

/**
 * Build a system prompt append string containing runtime context.
 *
 * Returns XML key-value blocks mirroring Claude Code's own `<env>` structure.
 * Never throws — all errors result in partial context (git failures produce
 * `Is git repo: false`).
 */
export async function buildSystemPromptAppend(cwd: string): Promise<string> {
  const [envResult, gitResult] = await Promise.allSettled([
    buildEnvBlock(cwd),
    buildGitBlock(cwd),
  ]);

  return [
    envResult.status === 'fulfilled' ? envResult.value : '',
    gitResult.status === 'fulfilled' ? gitResult.value : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Build the `<env>` block with system and DorkOS metadata. */
async function buildEnvBlock(cwd: string): Promise<string> {
  const lines = [
    `Working directory: ${cwd}`,
    `Product: DorkOS`,
    `Version: ${process.env.DORKOS_VERSION ?? 'development'}`,
    `Port: ${process.env.DORKOS_PORT ?? '4242'}`,
    `Platform: ${os.platform()}`,
    `OS Version: ${os.release()}`,
    `Node.js: ${process.version}`,
    `Hostname: ${os.hostname()}`,
    `Date: ${new Date().toISOString()}`,
  ];

  return `<env>\n${lines.join('\n')}\n</env>`;
}

/**
 * Build the `<git_status>` block from git status data.
 *
 * For non-git directories or git failures, returns a minimal block
 * with `Is git repo: false`.
 */
async function buildGitBlock(cwd: string): Promise<string> {
  try {
    const status = await getGitStatus(cwd);

    // Non-git directory (error response)
    if ('error' in status) {
      return '<git_status>\nIs git repo: false\n</git_status>';
    }

    const gitStatus = status as GitStatusResponse;
    const lines: string[] = [
      'Is git repo: true',
      `Current branch: ${gitStatus.branch}`,
      'Main branch (use for PRs): main',
    ];

    if (gitStatus.ahead > 0) {
      lines.push(`Ahead of origin: ${gitStatus.ahead} commits`);
    }
    if (gitStatus.behind > 0) {
      lines.push(`Behind origin: ${gitStatus.behind} commits`);
    }
    if (gitStatus.detached) {
      lines.push('Detached HEAD: true');
    }

    if (gitStatus.clean) {
      lines.push('Working tree: clean');
    } else {
      const parts: string[] = [];
      if (gitStatus.modified > 0) parts.push(`${gitStatus.modified} modified`);
      if (gitStatus.staged > 0) parts.push(`${gitStatus.staged} staged`);
      if (gitStatus.untracked > 0) parts.push(`${gitStatus.untracked} untracked`);
      if (gitStatus.conflicted > 0) parts.push(`${gitStatus.conflicted} conflicted`);
      lines.push(`Working tree: dirty (${parts.join(', ')})`);
    }

    return `<git_status>\n${lines.join('\n')}\n</git_status>`;
  } catch (err) {
    logger.warn('[buildGitBlock] git status failed, returning non-git block', { err });
    return '<git_status>\nIs git repo: false\n</git_status>';
  }
}
