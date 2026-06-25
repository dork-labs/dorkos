/**
 * @vitest-environment jsdom
 *
 * The session-view workspace indicator (DOR-84): GitStatusItem leads with the
 * workspace identity when bound, and renders unchanged (branch-led) otherwise.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

afterEach(cleanup);
import type { GitStatusResponse } from '@dorkos/shared/types';
import type { Workspace } from '@dorkos/shared/workspace';
import { GitStatusItem } from '../ui/GitStatusItem';

const gitOk = {
  branch: 'dork/DOR-84',
  ahead: 2,
  behind: 0,
  modified: 3,
  staged: 0,
  untracked: 0,
  conflicted: 0,
} as unknown as GitStatusResponse;

const workspace: Workspace = {
  id: 'ws_1',
  projectKey: 'core',
  key: 'DOR-84',
  path: '/root/core/DOR-84',
  source: '/repo',
  branch: 'dork/DOR-84',
  provider: 'worktree',
  status: 'ready',
  portBase: 4290,
  portBlockSize: 10,
  hostname: null,
  url: null,
  pinned: false,
  createdAt: '2026-06-16T00:00:00.000Z',
  lastUsedAt: '2026-06-16T00:00:00.000Z',
};

describe('GitStatusItem — workspace indicator', () => {
  it('leads with the workspace key + project when bound', () => {
    render(<GitStatusItem data={gitOk} workspace={workspace} />);
    // Workspace-led: shows the key and project, not the raw branch inline.
    expect(screen.getByText('DOR-84')).toBeInTheDocument();
    expect(screen.getByText('· core')).toBeInTheDocument();
    expect(screen.getByText('· 3 changes')).toBeInTheDocument();
  });

  it('puts branch + provider + ports in the tooltip', () => {
    const { container } = render(<GitStatusItem data={gitOk} workspace={workspace} />);
    const title = container.querySelector('span[title]')?.getAttribute('title') ?? '';
    expect(title).toContain('dork/DOR-84');
    expect(title).toContain('worktree');
    expect(title).toContain('4290'); // DORKOS_PORT derived from portBase
  });

  it('renders the plain branch-led chip when no workspace is bound', () => {
    render(<GitStatusItem data={gitOk} workspace={null} />);
    // Branch shown inline, no project segment.
    expect(screen.getByText('dork/DOR-84')).toBeInTheDocument();
    expect(screen.queryByText('· core')).not.toBeInTheDocument();
  });

  it('still shows the "No repo" disabled state for a non-git cwd', () => {
    render(<GitStatusItem data={{ error: 'not_git_repo' }} workspace={null} />);
    expect(screen.getByText('No repo')).toBeInTheDocument();
  });
});
