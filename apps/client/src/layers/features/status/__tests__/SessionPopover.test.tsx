/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ServerConfig } from '@dorkos/shared/types';
import type { StatusBarPin } from '@dorkos/shared/config-schema';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { configKeys } from '@/layers/entities/config';
import { SessionPopover } from '../ui/SessionPopover';
import type { SessionDiagnostics } from '../model/session-diagnostics';
import type { StatusPromotionContext } from '../model/status-bar-registry';
import { makeDiagnostics } from './session-diagnostics-fixture';

const toastSuccess = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (m: string) => toastSuccess(m) } }));

const mockIsMobile = vi.fn(() => false);
vi.mock('@/layers/shared/model/media/use-is-mobile', () => ({ useIsMobile: () => mockIsMobile() }));

const writeText = vi.fn();
Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

/** A fully-populated session snapshot. */
function diagnostics(overrides: Partial<SessionDiagnostics> = {}): SessionDiagnostics {
  return makeDiagnostics(overrides);
}

/** Live state whose severity ranking orders the rows on a phone. */
function promotionContext(overrides: Partial<StatusPromotionContext> = {}): StatusPromotionContext {
  return {
    cwd: '/Users/dev/work/dorkos',
    git: { dirty: true, onDefaultBranch: false },
    contextPercent: 88,
    connectionState: 'connected',
    permissionMode: 'plan',
    permissionDescriptor: null,
    runtime: { isDefault: true, canSelect: false },
    usage: { kind: 'pay-as-you-go', costUsd: 0.35 },
    subagentsInFlight: 0,
    ...overrides,
  };
}

const controls = {
  sound: true,
  onToggleSound: vi.fn(),
  refresh: false,
  onToggleRefresh: vi.fn(),
};

/**
 * Pins live in server config (`ui.statusBar.pins`), so the panel needs a query
 * client and a transport. Seeds the config cache with `pins` and hands back the
 * transport so a pin click can be asserted as the PATCH it really is.
 */
function harness(pins: StatusBarPin[] = []) {
  const transport = createMockTransport({ updateConfig: vi.fn().mockResolvedValue(undefined) });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData(configKeys.current(), {
    ui: { statusBar: { pins } },
  } as unknown as ServerConfig);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
  return { transport, queryClient, wrapper };
}

/** Render the panel open, with a stub trigger. */
function renderPanel(
  props: Partial<Parameters<typeof SessionPopover>[0]> = {},
  pins: StatusBarPin[] = []
) {
  const { transport, wrapper: Wrapper } = harness(pins);
  const result = render(
    <Wrapper>
      <SessionPopover
        open
        onOpenChange={vi.fn()}
        diagnostics={diagnostics()}
        controls={controls}
        promotionContext={promotionContext()}
        {...props}
      />
    </Wrapper>
  );
  return { ...result, transport };
}

/** The rendered order of the Session group's rows, by registry key. */
function sessionRowOrder(): string[] {
  const sessionGroup = [...document.body.querySelectorAll('section')].find((s) =>
    s.querySelector('[data-testid="session-row-cwd"]')
  )!;
  return [...sessionGroup.querySelectorAll('[data-testid^="session-row-"]')].map((el) =>
    el.getAttribute('data-testid')!.replace('session-row-', '')
  );
}

beforeEach(() => {
  mockIsMobile.mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('SessionPopover — the trigger', () => {
  it('renders one labelled `⋯` that asks to open the panel', () => {
    const onOpenChange = vi.fn();
    renderPanel({ open: false, onOpenChange });
    const trigger = screen.getByRole('button', { name: 'Session details' });
    fireEvent.click(trigger);
    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('counts what the width budget could not fit, in the label as well as on screen', () => {
    // `aria-label` replaces a button's text, so a visible `+2` with no count in the
    // label would be honest to the eye and silent to a screen reader.
    renderPanel({ open: false, overflowCount: 2 });
    expect(screen.getByRole('button', { name: 'Session details, 2 more' })).toBeInTheDocument();
    expect(screen.getByText('+2')).toBeInTheDocument();
  });

  it('says nothing extra when the line fitted everything', () => {
    renderPanel({ open: false, overflowCount: 0 });
    expect(screen.getByRole('button', { name: 'Session details' })).toBeInTheDocument();
    expect(screen.queryByText(/^\+/)).not.toBeInTheDocument();
  });
});

describe('SessionPopover — rows', () => {
  it('groups rows under Session, Controls, and Diagnostics', () => {
    renderPanel();
    expect(screen.getByText('Session', { selector: 'h3' })).toBeInTheDocument();
    expect(screen.getByText('Controls')).toBeInTheDocument();
    expect(screen.getByText('Diagnostics')).toBeInTheDocument();
  });

  it('shows the live value beside each Session row', () => {
    renderPanel();
    expect(screen.getByText('dorkos')).toBeInTheDocument();
    expect(screen.getByText('dor-452 · changed')).toBeInTheDocument();
    expect(screen.getByText('88% full')).toBeInTheDocument();
    expect(screen.getByText('75% from cache')).toBeInTheDocument();
    expect(screen.getByText('$0.35')).toBeInTheDocument();
  });

  it('reports the queue depth and session id as diagnostics rows', () => {
    renderPanel();
    expect(screen.getByText('Queued messages')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('Session id')).toBeInTheDocument();
    expect(screen.getByText('session-42')).toBeInTheDocument();
  });

  it('pairs the connection state with the last applied event', () => {
    renderPanel();
    expect(screen.getByText('connected · event 412')).toBeInTheDocument();
  });
});

describe('SessionPopover — pins', () => {
  it('offers a pin on every Session row that can appear in the line', () => {
    renderPanel();
    for (const label of [
      'Directory',
      'Git',
      'Runtime',
      'Model',
      'Context',
      'Usage & cost',
      'Permissions',
    ]) {
      expect(
        screen.getByRole('button', { name: `Keep ${label} in the status bar` })
      ).toBeInTheDocument();
    }
  });

  it('offers no pin on diagnostics rows', () => {
    // The invariant that keeps pins from becoming ten visibility toggles again:
    // system-managed rows can never be promoted by hand.
    renderPanel();
    expect(screen.queryByRole('button', { name: /Keep Connection/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Keep Subagents/ })).toBeNull();
  });

  it('offers no pin on controls or on the cache row', () => {
    renderPanel();
    expect(screen.queryByRole('button', { name: /Keep Sound/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Keep Background refresh/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Keep Cache/ })).toBeNull();
  });

  it('saves the pin to server config when clicked', async () => {
    // Config, not localStorage: the same pins follow you to the next client, and
    // an agent can set them with `config_patch`.
    const { transport } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Keep Usage & cost in the status bar' }));
    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({
        ui: { statusBar: { pins: ['usage'] } },
      })
    );
  });

  it('reflects an existing pin as pressed and offers to remove it', async () => {
    const { transport } = renderPanel({}, ['git']);
    const pin = screen.getByRole('button', { name: 'Stop keeping Git in the status bar' });
    expect(pin).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(pin);
    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({ ui: { statusBar: { pins: [] } } })
    );
  });

  it('clears every pin from the footer, and offers nothing to clear when there are none', async () => {
    const { transport } = renderPanel({}, ['git', 'usage']);
    const reset = screen.getByRole('button', { name: /Reset pins/ });
    expect(reset).toBeEnabled();
    fireEvent.click(reset);
    await waitFor(() =>
      expect(transport.updateConfig).toHaveBeenCalledWith({ ui: { statusBar: { pins: [] } } })
    );
    // The optimistic write lands before the server answers, so the button
    // reports "nothing to clear" immediately.
    await waitFor(() => expect(screen.getByRole('button', { name: /Reset pins/ })).toBeDisabled());
  });
});

describe('SessionPopover — controls', () => {
  it('renders the sound and refresh settings as switches, not pins', () => {
    renderPanel();
    const sound = screen.getByRole('switch', { name: 'Play a sound when a turn finishes' });
    expect(sound).toBeChecked();
    fireEvent.click(sound);
    expect(controls.onToggleSound).toHaveBeenCalled();

    const refresh = screen.getByRole('switch', {
      name: 'Keep checking for updates in the background',
    });
    expect(refresh).not.toBeChecked();
  });
});

describe('SessionPopover — copy diagnostics', () => {
  it('copies one JSON blob and confirms with a toast', () => {
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /Copy diagnostics/ }));
    expect(writeText).toHaveBeenCalledTimes(1);
    const parsed: Record<string, unknown> = JSON.parse(writeText.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({ sessionId: 'session-42', lastEventSeq: 412, queueDepth: 2 });
    expect(toastSuccess).toHaveBeenCalledWith('Diagnostics copied to your clipboard');
  });
});

describe('SessionPopover — an action the line had no room for', () => {
  it('leads with it and closes the panel once it is taken', () => {
    // Supplied by the caller only when the width budget dropped the inline action
    // from the bar, so the fix is relocated rather than lost. The panel does not
    // second-guess that with a breakpoint of its own.
    const onOpenChange = vi.fn();
    const onAction = vi.fn();
    renderPanel({
      onOpenChange,
      urgentAction: { label: 'Compact conversation — 88% full', onAction },
    });
    const button = screen.getByRole('button', { name: 'Compact conversation — 88% full' });
    fireEvent.click(button);
    expect(onAction).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('shows nothing when the line kept the action itself', () => {
    renderPanel({ urgentAction: null });
    expect(screen.queryByRole('button', { name: /Compact conversation/ })).not.toBeInTheDocument();
  });
});

describe('SessionPopover — on a phone', () => {
  it('sorts Session rows attention-first', () => {
    // A 88%-full window outranks an elevated permission mode, which outranks a
    // dirty working tree — the same ranking the line uses for a contested slot.
    mockIsMobile.mockReturnValue(true);
    renderPanel();
    expect(sessionRowOrder().slice(0, 3)).toEqual(['context', 'permission', 'git']);
  });

  it('keeps registry order on desktop, where there is room for all of it', () => {
    renderPanel();
    expect(sessionRowOrder().slice(0, 3)).toEqual(['cwd', 'git', 'runtime']);
  });
});
