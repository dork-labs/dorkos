/**
 * Smoke test for the runtime-card showcases.
 *
 * The two components these cards replaced had no playground coverage at all, so
 * every regression in them was found by opening Settings. The cards are
 * props-only and the showcases drive them directly — which means a showcase can
 * now break on its own, quietly, in a file nobody runs. This renders the whole
 * page's worth of them and asserts the states that are easiest to get wrong.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createPlaygroundTransport } from '../playground-transport';
import { RuntimeCardShowcases } from '../showcases/RuntimeCardShowcases';

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  const proto = Element.prototype as unknown as Record<string, unknown>;
  if (!proto.hasPointerCapture) proto.hasPointerCapture = vi.fn();
  if (!proto.releasePointerCapture) proto.releasePointerCapture = vi.fn();
  if (!proto.scrollIntoView) proto.scrollIntoView = vi.fn();
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(cleanup);

/** The providers the playground shell supplies around every page. */
function renderShowcases() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={createPlaygroundTransport()}>
        <RuntimeCardShowcases />
      </TransportProvider>
    </QueryClientProvider>
  );
}

describe('runtime card showcases', () => {
  it('renders every section at the anchor the registry points at', () => {
    const { container } = renderShowcases();

    // By anchor id, not by heading text: the id is what ⌘K and the TOC navigate
    // to, so an id that drifts from its registry entry is the failure worth
    // catching here.
    for (const id of [
      'runtime-cards-the-status-board-at-rest',
      'runtime-cards-opened',
      'runtime-cards-when-something-is-wrong',
      'runtime-cards-on-a-phone',
    ]) {
      expect(container.querySelector(`#${id}`), id).not.toBeNull();
    }
  });

  it('crashes nowhere: the boundary that would hide a broken showcase is idle', () => {
    renderShowcases();

    // Every showcase renders inside a `ShowcaseErrorBoundary`, so a throw would
    // otherwise be swallowed into a small red panel and every assertion below
    // would go on passing against a page nobody could use.
    expect(screen.queryByText(/crashed$/)).toBeNull();
  });

  it('draws all three runtimes, connected and not', () => {
    renderShowcases();

    expect(screen.getAllByTestId('runtime-card-claude-code').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('runtime-card-codex').length).toBeGreaterThan(0);
    expect(screen.getAllByTestId('runtime-card-opencode').length).toBeGreaterThan(0);
    // The one sentence a card says instead of a summary it cannot honestly give.
    expect(screen.getAllByTestId('runtime-card-locked-opencode')[0]).toHaveTextContent(
      'One sign-in away'
    );
  });

  it('shows the broken default as both halves at once, never one', () => {
    renderShowcases();

    // The whole point of the state: the pill and the warning share a card,
    // because hiding either one hides the problem.
    const broken = screen.getByTestId('runtime-default-broken-opencode');
    const card = broken.closest('[data-testid="runtime-card-opencode"]');
    expect(card).not.toBeNull();
    expect(within(card as HTMLElement).getByTestId('runtime-default-pill-opencode')).toBeVisible();
    expect(broken).toHaveTextContent('Your default runtime isn’t connected');
  });

  it('admits the capped catalog in exactly one demo, and no other grows one', () => {
    renderShowcases();
    // One demo hands its card an all-unverified catalog (DOR-1674); every
    // other card's mock catalog is confirmed, so exactly one admission renders.
    expect(screen.getAllByTestId('model-catalog-unverified').length).toBe(1);
  });

  it('keeps a retired model selectable rather than blanking the field', () => {
    renderShowcases();

    expect(
      screen.getAllByTestId('runtime-model-select-claude-code').some((select) =>
        // Said in the field itself, not hidden behind an open listbox.
        select.textContent?.includes('no longer offered')
      )
    ).toBe(true);
  });

  it('offers a way out of an effort that does nothing where it is saved', () => {
    renderShowcases();

    expect(screen.getByTestId('runtime-effort-clear-claude-code')).toHaveTextContent(
      'is saved here and does nothing'
    );
  });

  it('says a runtime has no effort setting rather than dropping the row', () => {
    renderShowcases();

    expect(screen.getAllByTestId('runtime-effort-unsupported-opencode')[0]).toHaveTextContent(
      'Not supported by OpenCode'
    );
  });

  it('renders the sections a runtime declares, and nothing where it declares none', () => {
    renderShowcases();

    expect(screen.getAllByTestId('runtime-card-section-claude-accounts-claude-code').length).toBe(
      1
    );
    expect(
      screen.getAllByTestId('runtime-card-section-opencode-power-source-opencode').length
    ).toBeGreaterThan(0);
    // Codex declares no sections at all, so its opened body ends after the rows.
    expect(screen.queryByTestId('runtime-card-section-claude-accounts-codex')).toBeNull();
  });
});
