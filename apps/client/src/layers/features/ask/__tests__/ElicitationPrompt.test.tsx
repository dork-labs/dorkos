/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { createMockTransport } from '@dorkos/test-utils';
import { TransportProvider } from '@/layers/shared/model';
import { ElicitationPrompt } from '../ui/ElicitationPrompt';

const submitElicitation = vi.fn().mockResolvedValue(undefined);
const transport = Object.assign(createMockTransport(), { submitElicitation });

function renderPrompt(props: Partial<Parameters<typeof ElicitationPrompt>[0]> = {}) {
  return render(
    <TransportProvider transport={transport}>
      <ElicitationPrompt
        sessionId="session-1"
        interactionId="interaction-1"
        serverName="acme-mcp"
        message="Authorize acme-mcp"
        mode="url"
        url="https://acme.example/authorize"
        status="pending"
        {...props}
      />
    </TransportProvider>
  );
}

let openSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  submitElicitation.mockClear();
  openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  openSpy.mockRestore();
  warnSpy.mockRestore();
  cleanup();
});

describe('ElicitationPrompt — URL mode', () => {
  it('opens the authorization page in the browser', () => {
    renderPrompt();
    fireEvent.click(screen.getByRole('button', { name: 'Open authorization page' }));

    expect(openSpy).toHaveBeenCalledWith(
      'https://acme.example/authorize',
      '_blank',
      'noopener,noreferrer'
    );
  });

  it('offers the confirm button only after the page actually opened', () => {
    renderPrompt();
    expect(screen.queryByRole('button', { name: /Done/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open authorization page' }));
    expect(screen.getByRole('button', { name: 'Done — I authorized' })).toBeInTheDocument();
  });

  it('refuses a scheme the link seam does not dispatch, and says so', () => {
    // An MCP server can name a plausible-looking desktop deep link. Nothing
    // opens, so the prompt must not offer to confirm an authorization that
    // never ran — that would let the user accept a flow that never happened.
    renderPrompt({ url: 'myapp://authorize' });
    fireEvent.click(screen.getByRole('button', { name: 'Open authorization page' }));

    expect(openSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Done/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Could not open myapp:\/\/authorize/)).toBeInTheDocument();
  });

  it('refuses a file: URL from the http cockpit, where it could not open anyway', () => {
    // Browsers block file: from an http: page and the desktop shell forwards
    // only http(s), so a local authorization page is a guaranteed no-op — and
    // must not be reported as opened.
    renderPrompt({ url: 'file:///Users/kai/authorize.html' });
    fireEvent.click(screen.getByRole('button', { name: 'Open authorization page' }));

    expect(openSpy).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Done/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Could not open/)).toBeInTheDocument();
  });

  it('never submits an acceptance for a link that never opened', () => {
    renderPrompt({ url: 'javascript:alert(1)' });
    fireEvent.click(screen.getByRole('button', { name: 'Open authorization page' }));

    // Click any confirm affordance that exists rather than asserting none does:
    // if the gate regresses, a Done button appears here, gets clicked, and the
    // assertion below fails. Asserting absence alone would hold either way.
    screen.queryAllByRole('button', { name: /Done/ }).forEach((btn) => fireEvent.click(btn));

    expect(submitElicitation).not.toHaveBeenCalled();
  });

  it('clears a previous refusal once a link does open', () => {
    const { rerender } = renderPrompt({ url: 'myapp://authorize' });
    fireEvent.click(screen.getByRole('button', { name: 'Open authorization page' }));
    expect(screen.getByText(/Could not open/)).toBeInTheDocument();

    rerender(
      <TransportProvider transport={transport}>
        <ElicitationPrompt
          sessionId="session-1"
          interactionId="interaction-1"
          serverName="acme-mcp"
          message="Authorize acme-mcp"
          mode="url"
          url="https://acme.example/authorize"
          status="pending"
        />
      </TransportProvider>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open authorization page' }));

    expect(screen.queryByText(/Could not open/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done — I authorized' })).toBeInTheDocument();
  });

  it('submits the acceptance once the user confirms a real open', async () => {
    renderPrompt();
    fireEvent.click(screen.getByRole('button', { name: 'Open authorization page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done — I authorized' }));

    await waitFor(() => {
      expect(submitElicitation).toHaveBeenCalledWith(
        'session-1',
        'interaction-1',
        'accept',
        undefined
      );
    });
  });

  it('submits a decline without opening anything', async () => {
    renderPrompt();
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));

    await waitFor(() => {
      expect(submitElicitation).toHaveBeenCalledWith(
        'session-1',
        'interaction-1',
        'decline',
        undefined
      );
    });
    expect(openSpy).not.toHaveBeenCalled();
  });
});
