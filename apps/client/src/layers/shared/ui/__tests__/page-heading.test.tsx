// @vitest-environment jsdom
/**
 * The page heading is where a deliberate move to a new page puts focus (spec
 * `community-switcher-navigation`, Phone and narrow widths). These cases pin
 * what it draws — nothing, unless it is the drawn title — and which heading
 * `focusPageHeading` chooses when a page has more than one candidate.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { PAGE_HEADING_PENDING_WAIT_MS, PageHeading, focusPageHeading } from '../page-heading';

afterEach(() => cleanup());

describe('PageHeading', () => {
  it('is an undrawn h1 that script can focus and Tab never reaches', () => {
    render(<PageHeading>Schedules</PageHeading>);
    const heading = screen.getByRole('heading', { level: 1, name: 'Schedules' });
    expect(heading).toHaveClass('sr-only');
    expect(heading).toHaveAttribute('tabindex', '-1');
  });

  it('is drawn, without a focus ring, only when asked to be the visible title', () => {
    render(
      <PageHeading visible className="text-sm">
        #general
      </PageHeading>
    );
    const heading = screen.getByRole('heading', { level: 1, name: '#general' });
    expect(heading).not.toHaveClass('sr-only');
    expect(heading).toHaveClass('outline-none', 'text-sm');
  });
});

describe('focusPageHeading', () => {
  it('focuses the page’s own heading inside main, not one in the chrome above it', async () => {
    render(
      <>
        <header>
          <PageHeading visible>Bar title</PageHeading>
        </header>
        <main>
          <PageHeading>Alpha · General</PageHeading>
        </main>
      </>
    );
    focusPageHeading();
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Alpha · General' })).toHaveFocus()
    );
  });

  it('takes the bar’s heading when the page draws its name only there', async () => {
    render(
      <>
        <header>
          <PageHeading visible>#general</PageHeading>
        </header>
        <main>
          <p>The room</p>
        </main>
      </>
    );
    focusPageHeading();
    await waitFor(() => expect(screen.getByRole('heading', { name: '#general' })).toHaveFocus());
  });

  it('never picks a heading inside a dialog', async () => {
    render(
      <>
        <div role="dialog">
          <PageHeading>In a sheet</PageHeading>
        </div>
        <main>
          <h1>A package</h1>
        </main>
      </>
    );
    focusPageHeading();
    const plain = screen.getByRole('heading', { name: 'A package' });
    await waitFor(() => expect(plain).toHaveFocus());
    // A plain h1 is made focusable by script only, never a Tab stop.
    expect(plain).toHaveAttribute('tabindex', '-1');
  });

  it('leaves focus alone on a page with no heading', async () => {
    render(
      <main>
        <button type="button">Stay</button>
      </main>
    );
    const button = screen.getByRole('button', { name: 'Stay' });
    button.focus();
    focusPageHeading();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(button).toHaveFocus();
  });

  it('waits for a pending heading’s full name, so focus lands on all of it', async () => {
    const { rerender } = render(
      <main>
        <PageHeading pending>Alpha</PageHeading>
      </main>
    );
    const heading = screen.getByRole('heading', { level: 1 });
    // What the heading said at the moment it took focus: what gets read aloud.
    const spoken: string[] = [];
    heading.addEventListener('focus', () => spoken.push(heading.textContent ?? ''));
    const focused = focusPageHeading();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(heading).not.toHaveFocus();
    rerender(
      <main>
        <PageHeading>Alpha · General</PageHeading>
      </main>
    );
    await expect(focused).resolves.toBe(true);
    expect(heading).toHaveFocus();
    expect(spoken).toEqual(['Alpha · General']);
  });

  it('stops waiting after a short cap, so a name that never comes cannot hold focus back', async () => {
    render(
      <main>
        <PageHeading pending>Alpha</PageHeading>
      </main>
    );
    const started = performance.now();
    await expect(focusPageHeading()).resolves.toBe(true);
    expect(performance.now() - started).toBeGreaterThanOrEqual(PAGE_HEADING_PENDING_WAIT_MS - 50);
    expect(screen.getByRole('heading', { name: 'Alpha' })).toHaveFocus();
  });

  it('gives up if the person acts while it waits', async () => {
    render(
      <main>
        <PageHeading pending>Alpha</PageHeading>
      </main>
    );
    let acted = false;
    const focused = focusPageHeading({ cancelled: () => acted });
    await new Promise((resolve) => setTimeout(resolve, 50));
    acted = true;
    await expect(focused).resolves.toBe(false);
    expect(screen.getByRole('heading', { name: 'Alpha' })).not.toHaveFocus();
  });
});
