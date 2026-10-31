/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { ListRow } from '../list-row';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
});

afterEach(cleanup);

const row = () => document.querySelector('[data-slot="list-row"]') as HTMLElement;

describe('ListRow', () => {
  it('a row with no onSelect is static: not a button and not a Tab stop', async () => {
    render(
      <>
        <ListRow title="Build the thing" meta="3m" />
        <button type="button">after</button>
      </>
    );
    expect(screen.queryByRole('button', { name: /Build the thing/ })).toBeNull();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'after' })).toHaveFocus();
    expect(row()).toHaveAttribute('data-row-state', 'rest');
  });

  it('a row with onSelect is one button that fires it', () => {
    const onSelect = vi.fn();
    render(<ListRow title="Morning digest" onSelect={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /Morning digest/ }));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('selected sets aria-selected and the selected state', () => {
    render(<ListRow title="Inbox" selected onSelect={() => {}} />);
    expect(screen.getByRole('button', { name: /Inbox/ })).toHaveAttribute('aria-selected', 'true');
    expect(row()).toHaveAttribute('data-row-state', 'selected');
  });

  it('current sets aria-current="page" and draws as selected', () => {
    render(<ListRow title="Schedules" current onSelect={() => {}} />);
    const target = screen.getByRole('button', { name: /Schedules/ });
    expect(target).toHaveAttribute('aria-current', 'page');
    expect(target).not.toHaveAttribute('aria-selected');
    expect(row()).toHaveAttribute('data-row-state', 'selected');
  });

  it('emphasized stamps the emphasized state', () => {
    render(<ListRow title="Unread" emphasized onSelect={() => {}} />);
    expect(row()).toHaveAttribute('data-row-state', 'emphasized');
  });

  it('disabledReason keeps the row focusable, says why, and does not fire', async () => {
    const onSelect = vi.fn();
    render(<ListRow title="Reconnect" disabledReason="Sign in first" onSelect={onSelect} />);
    const target = screen.getByRole('button', { name: /Reconnect/ });
    expect(target).toHaveAttribute('aria-disabled', 'true');
    expect(target).toHaveAttribute('title', 'Sign in first');
    await userEvent.tab();
    expect(target).toHaveFocus();
    fireEvent.click(target);
    expect(onSelect).not.toHaveBeenCalled();
    expect(row()).toHaveAttribute('data-row-state', 'disabled');
  });

  it('renders actions as siblings of the row button, never inside it', () => {
    render(
      <ListRow
        title="Nightly report"
        onSelect={() => {}}
        actions={
          <button type="button" aria-label="Run now">
            ▶
          </button>
        }
      />
    );
    const target = screen.getByRole('button', { name: /Nightly report/ });
    const action = screen.getByRole('button', { name: 'Run now' });
    expect(target.contains(action)).toBe(false);
    expect(target.querySelector('button')).toBeNull();
  });

  it('reveals actions on focus-within as well as hover', () => {
    render(
      <ListRow
        title="Nightly report"
        onSelect={() => {}}
        actions={
          <button type="button" aria-label="Run now">
            ▶
          </button>
        }
      />
    );
    const actions = document.querySelector('[data-slot="list-row-actions"]') as HTMLElement;
    expect(actions.className).toContain('group-hover/row:opacity-100');
    expect(actions.className).toContain('group-focus-within/row:opacity-100');
    expect(actions.className).toContain('pointer-coarse:opacity-100');
  });

  it('puts the whole label, who included, in the tooltip', () => {
    render(<ListRow title="Fix the build" who="dorkbot" onSelect={() => {}} />);
    expect(screen.getByRole('button', { name: /Fix the build/ })).toHaveAttribute(
      'title',
      'dorkbot › Fix the build'
    );
  });

  it('asChild renders the row body inside the caller element', () => {
    render(
      <ListRow asChild title="Open settings">
        {/* The row's body becomes the anchor's content. */}
        {/* eslint-disable-next-line jsx-a11y/anchor-has-content */}
        <a href="/settings" />
      </ListRow>
    );
    const link = screen.getByRole('link', { name: /Open settings/ });
    expect(link).toHaveAttribute('href', '/settings');
    expect(link).toHaveAttribute('data-slot', 'list-row-target');
  });

  describe('on a narrow row (390px)', () => {
    it('puts the meta and the trailing state on the subtitle line, joined with " · "', () => {
      render(
        <ListRow
          title="Calendar sync"
          meta="7:00"
          trailing="Reconnect"
          secondLine="Last ran 3h ago"
          onSelect={() => {}}
        />
      );
      const subtitle = document.querySelector('[data-slot="list-row-subtitle"]') as HTMLElement;
      expect(subtitle.textContent).toBe('7:00·Reconnect·Last ran 3h ago');
      // The title-line copies are the wide-row layout; a container query
      // hides them under 24rem (checked in apps/e2e list-rows-390.spec.ts).
      expect(document.querySelector('[data-slot="list-row-trailing"]')?.className).toContain(
        '@min-[24rem]/row:flex'
      );
    });

    it('a one-line row with only a meta still gets a subtitle to move it to', () => {
      render(<ListRow title="Morning digest" meta="7:00" onSelect={() => {}} />);
      expect(document.querySelector('[data-slot="list-row-subtitle-meta"]')).toHaveTextContent(
        '7:00'
      );
    });

    it('wrapTitle wraps the state copy, and its trailing moves under it on a narrow row', () => {
      render(
        <ListRow title="Couldn't load schedules." wrapTitle trailing={<span>Try again</span>} />
      );
      const title = document.querySelector('[data-slot="list-row-title"]') as HTMLElement;
      expect(title).toHaveAttribute('data-wrap', 'true');
      expect(title.className).not.toContain('truncate');
      expect(document.querySelector('[data-slot="list-row-subtitle-trailing"]')).toHaveTextContent(
        'Try again'
      );
    });

    it('actions leave the flow at rest on a narrow row, and come back on hover and focus', () => {
      render(
        <ListRow
          title="Morning digest"
          onSelect={() => {}}
          actions={
            <button type="button" aria-label="Run now">
              ▶
            </button>
          }
        />
      );
      const actions = document.querySelector('[data-slot="list-row-actions"]') as HTMLElement;
      expect(actions.className).toContain('@max-[24rem]/row:hidden');
      expect(actions.className).toContain('@max-[24rem]/row:group-hover/row:flex');
      expect(actions.className).toContain('@max-[24rem]/row:group-focus-within/row:flex');
      expect(actions.className).toContain('@max-[24rem]/row:pointer-coarse:flex');
    });
  });
});
