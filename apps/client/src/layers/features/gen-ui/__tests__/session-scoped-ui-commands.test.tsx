/**
 * @vitest-environment jsdom
 */
/**
 * What a `ui`-kind widget action may do with no session behind it (DOR-1997).
 *
 * A widget in a session belongs to that session. A widget in a room message
 * belongs to nobody — it can arrive from an agent the reader does not run, or
 * be relayed in from a bridged Telegram or Slack room by a stranger — and every
 * viewer's click runs against THEIR app. So the line these tests pin is not
 * "`ui` actions work": it is that the session-shaped half of the `ui` command
 * set (canvas, browser, file, diff, terminal, PiP, agent switching, layout) is
 * inert on a session-less surface, while the local, visible, reversible half
 * stays live — and that the same command is untouched in chat, where a session
 * exists and the person clicking owns it.
 *
 * The seam is `widget-context`, so these drive it directly rather than through
 * a room: what a ROOM does with it is `RoomMessage.widget-fence.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { ReactNode } from 'react';
import type { WidgetAction, WidgetDocument } from '@dorkos/shared/ui-widget';
import { TransportProvider, useAppStore } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { WidgetRenderer } from '../ui/WidgetRenderer';
import { WidgetActionProvider, useWidgetActions } from '../model/widget-context';

const mockTransport = createMockTransport();

function Wrapper({ children }: { children: ReactNode }) {
  return <TransportProvider transport={mockTransport}>{children}</TransportProvider>;
}

/** The command the reviewer's probe used: an arbitrary URL, into someone's canvas. */
const HOSTILE: WidgetAction = {
  kind: 'ui',
  command: { action: 'browser_navigate', url: 'https://evil.example/steal' },
};

/** The other half of the line: local chrome the reader can undo by looking at it. */
const LOCAL: WidgetAction = {
  kind: 'ui',
  command: { action: 'open_panel', panel: 'settings' },
};

function buttonDoc(label: string, action: WidgetAction): WidgetDocument {
  return { version: 1, title: 'Controls', root: { type: 'button', label, action } };
}

let openCanvasDocument: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // Spy on the live store action the canvas branch of the dispatcher calls —
  // the single write every canvas-class command has to go through.
  openCanvasDocument = vi.spyOn(useAppStore.getState(), 'openCanvasDocument');
  useAppStore.setState({ settingsOpen: false, rightPanelOpen: false, canvasOpen: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useAppStore.setState({ settingsOpen: false, rightPanelOpen: false, canvasOpen: false });
});

describe('ui commands on a surface with no session', () => {
  it('renders a session-shaped ui control inert, with the same off-session tooltip', async () => {
    const user = userEvent.setup();
    render(<WidgetRenderer document={buttonDoc('Preview it', HOSTILE)} />, { wrapper: Wrapper });

    const button = screen.getByRole('button', { name: 'Preview it' });
    expect(button).toHaveAttribute('aria-disabled', 'true');

    await user.hover(button);
    expect(await screen.findByRole('tooltip')).toHaveTextContent(
      'Interactions aren’t available here'
    );

    await user.click(button);
    // Nothing reached the canvas, and nothing revealed the right panel.
    expect(openCanvasDocument).not.toHaveBeenCalled();
    expect(useAppStore.getState().canvasOpen).toBe(false);
    expect(useAppStore.getState().rightPanelOpen).toBe(false);
  });

  it('keeps a local-UI-only ui control live', async () => {
    const user = userEvent.setup();
    render(<WidgetRenderer document={buttonDoc('Open settings', LOCAL)} />, { wrapper: Wrapper });

    const button = screen.getByRole('button', { name: 'Open settings' });
    expect(button).not.toHaveAttribute('aria-disabled');
    await user.click(button);
    expect(useAppStore.getState().settingsOpen).toBe(true);
  });

  it('refuses a session-shaped command dispatched straight through onAction', async () => {
    // The node-level gate is the visible half. This is the guard underneath it:
    // a widget node that forgot to ask — or a future caller of `onAction` —
    // must not be able to run the command either. Same shape as the `agent`
    // branch's own `if (!sessionId) return`.
    const user = userEvent.setup();
    function Dispatcher({ action }: { action: WidgetAction }) {
      const { onAction } = useWidgetActions();
      return (
        <button type="button" onClick={() => void onAction(action)}>
          dispatch
        </button>
      );
    }
    render(
      <WidgetActionProvider>
        <Dispatcher action={HOSTILE} />
      </WidgetActionProvider>,
      { wrapper: Wrapper }
    );

    await user.click(screen.getByRole('button', { name: 'dispatch' }));
    expect(openCanvasDocument).not.toHaveBeenCalled();
    expect(useAppStore.getState().canvasOpen).toBe(false);
  });
});

describe('ui commands with a session behind the widget (chat, canvas)', () => {
  it('still runs a session-shaped ui command and reveals the canvas — unchanged', async () => {
    // The other side of the gate. In a session the widget belongs to the
    // conversation the person is already reading, so this is the behaviour
    // DOR-1997 must not have touched.
    const user = userEvent.setup();
    render(<WidgetRenderer sessionId="sess-1" document={buttonDoc('Preview it', HOSTILE)} />, {
      wrapper: Wrapper,
    });

    const button = screen.getByRole('button', { name: 'Preview it' });
    expect(button).not.toHaveAttribute('aria-disabled');

    await user.click(button);
    expect(openCanvasDocument).toHaveBeenCalledWith({
      type: 'browser',
      url: 'https://evil.example/steal',
    });
    expect(useAppStore.getState().canvasOpen).toBe(true);
    expect(useAppStore.getState().rightPanelOpen).toBe(true);
  });
});
