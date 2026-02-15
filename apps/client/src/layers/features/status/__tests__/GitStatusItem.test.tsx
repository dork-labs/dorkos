// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GitStatusItem } from '../ui/GitStatusItem';
import type { GitStatusResponse, GitStatusError } from '@dorkos/shared/types';

const cleanStatus: GitStatusResponse = {
  branch: 'main',
  ahead: 0,
  behind: 0,
  modified: 0,
  staged: 0,
  untracked: 0,
  conflicted: 0,
  clean: true,
  detached: false,
  tracking: 'origin/main',
};

const dirtyStatus: GitStatusResponse = {
  branch: 'feature/my-branch',
  ahead: 2,
  behind: 1,
  modified: 3,
  staged: 1,
  untracked: 2,
  conflicted: 0,
  clean: false,
  detached: false,
  tracking: 'origin/feature/my-branch',
};

const errorStatus: GitStatusError = { error: 'not_git_repo' };

describe('GitStatusItem', () => {
  it('renders branch name for clean repo', () => {
    render(<GitStatusItem data={cleanStatus} />);
    expect(screen.getByText('main')).toBeDefined();
  });

  it('does not show change count for clean repo', () => {
    render(<GitStatusItem data={cleanStatus} />);
    expect(screen.queryByText(/changes?/)).toBeNull();
  });

  it('renders change count when dirty', () => {
    render(<GitStatusItem data={dirtyStatus} />);
    expect(screen.getByText(/6 changes/)).toBeDefined();
  });

  it('renders singular "1 change" for single file', () => {
    render(<GitStatusItem data={{ ...cleanStatus, modified: 1, clean: false }} />);
    expect(screen.getByText(/1 change$/)).toBeDefined();
  });

  it('renders ahead indicator', () => {
    render(<GitStatusItem data={{ ...cleanStatus, ahead: 5 }} />);
    expect(screen.getByText('5')).toBeDefined();
  });

  it('renders behind indicator', () => {
    render(<GitStatusItem data={{ ...cleanStatus, behind: 3 }} />);
    expect(screen.getByText('3')).toBeDefined();
  });

  it('renders both ahead and behind', () => {
    const data: GitStatusResponse = {
      ...cleanStatus, ahead: 4, behind: 7,
      modified: 1, clean: false,
    };
    render(<GitStatusItem data={data} />);
    expect(screen.getByText('4')).toBeDefined();
    expect(screen.getByText('7')).toBeDefined();
  });

  it('renders "No repo" in disabled state for error response', () => {
    render(<GitStatusItem data={errorStatus} />);
    expect(screen.getByText('No repo')).toBeDefined();
  });

  it('does not render when data is undefined', () => {
    const { container } = render(<GitStatusItem data={undefined} />);
    expect(container.firstChild).toBeNull();
  });

  it('truncates long branch names via CSS class', () => {
    render(<GitStatusItem data={{ ...cleanStatus, branch: 'feature/very-long-branch-name-that-should-be-truncated' }} />);
    const branchEl = screen.getByText('feature/very-long-branch-name-that-should-be-truncated');
    expect(branchEl.className).toContain('truncate');
    expect(branchEl.className).toContain('max-w-[25ch]');
  });

  it('sets title attribute with tooltip breakdown', () => {
    const { container } = render(<GitStatusItem data={dirtyStatus} />);
    const el = container.querySelector('[title]') as HTMLElement;
    expect(el).toBeDefined();
    expect(el.title).toContain('feature/my-branch');
    expect(el.title).toContain('3 modified');
    expect(el.title).toContain('1 staged');
    expect(el.title).toContain('2 untracked');
  });

  it('sets title to "clean" for clean repo', () => {
    const { container } = render(<GitStatusItem data={cleanStatus} />);
    const el = container.querySelector('[title]') as HTMLElement;
    expect(el).toBeDefined();
    expect(el.title).toContain('main');
    expect(el.title).toContain('clean');
  });
});
