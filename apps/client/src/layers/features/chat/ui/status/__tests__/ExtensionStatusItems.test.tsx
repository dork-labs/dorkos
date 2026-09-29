/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { StatusBarSlotContext } from '@dorkos/extension-api';
import type { StatusBarContribution } from '@/layers/shared/model';
import { ExtensionStatusItems, ExtensionStatusRows } from '../ExtensionStatusItems';

const CTX: StatusBarSlotContext = {
  sessionId: 's1',
  cwd: '/repo',
  project: { root: '/repo', name: 'repo' },
  trackerItems: [],
  compact: false,
};

function item(id: string, overrides: Partial<StatusBarContribution> = {}): StatusBarContribution {
  return {
    id: `ext:${id}`,
    extensionId: 'ext',
    label: id,
    priority: 100,
    component: ({ project }) => <span>{`${id} in ${project?.name ?? 'none'}`}</span>,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ExtensionStatusItems', () => {
  it('draws each item in its own labelled group, with the chat’s context', () => {
    render(<ExtensionStatusItems ctx={CTX} items={[item('one'), item('two')]} />);
    expect(screen.getByRole('group', { name: 'one' })).toHaveTextContent('one in repo');
    expect(screen.getByRole('group', { name: 'two' })).toHaveTextContent('two in repo');
  });

  it('keeps the others when one item throws while drawing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const Broken = () => {
      throw new Error('boom');
    };
    render(
      <ExtensionStatusItems ctx={CTX} items={[item('broken', { component: Broken }), item('ok')]} />
    );
    expect(screen.getByRole('group', { name: 'ok' })).toHaveTextContent('ok in repo');
    expect(screen.getByRole('group', { name: 'broken' })).toBeEmptyDOMElement();
  });
});

describe('ExtensionStatusRows (the Session panel)', () => {
  it('lists every shown item by its name, with the item itself beside it', () => {
    render(<ExtensionStatusRows ctx={CTX} items={[item('run chip')]} />);
    const row = screen.getByRole('group', { name: 'run chip' });
    expect(row).toHaveTextContent('run chip');
    expect(row).toHaveTextContent('run chip in repo');
  });

  it('keeps the row when the item throws while drawing', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const Broken = () => {
      throw new Error('boom');
    };
    render(<ExtensionStatusRows ctx={CTX} items={[item('broken', { component: Broken })]} />);
    expect(screen.getByRole('group', { name: 'broken' })).toHaveTextContent('broken');
  });
});
