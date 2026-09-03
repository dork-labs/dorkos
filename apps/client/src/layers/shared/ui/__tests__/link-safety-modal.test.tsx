// @vitest-environment jsdom
/**
 * `LinkSafetyModal` — the confirmation every untrusted link in the app renders
 * through (`MarkdownLink`, gen-UI widget `url` actions, MCP App iframes).
 *
 * The behaviour under test is DOR-547's design ruling: the modal asks the link
 * seam BEFORE it offers to open anything, so a scheme `classifyLink` refuses
 * never gets a button whose only possible outcome is a refusal.
 */
import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { LinkSafetyModal } from '../link-safety-modal';

afterEach(() => cleanup());

/**
 * The fill `Button`'s default variant paints — how a dialog says which of its
 * actions is the one you came for. It used to be `bg-foreground`, the modal's
 * own hand-rolled recipe; the modal composes `Button` now.
 */
const PRIMARY_CLASS = 'bg-primary';

describe('LinkSafetyModal — the dialog claims it keeps (3.3)', () => {
  it('moves focus inside the dialog on open, instead of leaving it on the trigger behind it', () => {
    render(
      <LinkSafetyModal
        url="https://dorkos.ai/docs"
        isOpen
        onClose={() => {}}
        onConfirm={() => {}}
      />
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('closes on Escape, reaching the handler instead of the page underneath', () => {
    const onClose = vi.fn();
    render(
      <LinkSafetyModal url="https://dorkos.ai/docs" isOpen onClose={onClose} onConfirm={() => {}} />
    );

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('restores focus to the link when it closes, instead of dropping it to the document body', async () => {
    // There is no `DialogTrigger` here — `isOpen` is driven by a caller with
    // no trigger element for Radix to remember, so its own trigger-focused
    // close-restore is a no-op (`triggerRef.current` is always null). The
    // real link that opened the modal has to be captured and restored by
    // hand, or Escape/close strands a keyboard reader at `document.body`.
    function Harness() {
      const [isOpen, setIsOpen] = useState(false);
      return (
        <>
          <button type="button" data-testid="the-link" onClick={() => setIsOpen(true)}>
            docs
          </button>
          <LinkSafetyModal
            url="https://dorkos.ai/docs"
            isOpen={isOpen}
            onClose={() => setIsOpen(false)}
            onConfirm={() => {}}
          />
        </>
      );
    }

    const { getByTestId } = render(<Harness />);
    const link = getByTestId('the-link');
    // The real sequence: the link has focus, Enter/click opens the modal —
    // the same render pass that mounts the dialog and moves focus inside it.
    link.focus();
    fireEvent.click(link);
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    // Radix's own `FocusScope` fires its unmount-focus restoration from a
    // `setTimeout(0)` in its cleanup — a macrotask, not a microtask a bare
    // `act()` flush would catch — so the assertion has to wait for it.
    await waitFor(() => expect(document.activeElement).toBe(link));
  });
});

describe('LinkSafetyModal — a link that can open', () => {
  it('offers to open it, with copy as the secondary action', () => {
    render(
      <LinkSafetyModal
        url="https://dorkos.ai/docs"
        isOpen
        onClose={() => {}}
        onConfirm={() => {}}
      />
    );

    expect(screen.getByRole('dialog', { name: /open external link/i })).toBeInTheDocument();
    expect(screen.getByText(/about to visit an external website/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open link/i })).toHaveClass(PRIMARY_CLASS);
    expect(screen.getByRole('button', { name: /copy link/i })).not.toHaveClass(PRIMARY_CLASS);
  });

  it('confirms through the caller, which is what reaches the seam', () => {
    const onConfirm = vi.fn();
    render(
      <LinkSafetyModal
        url="https://dorkos.ai/docs"
        isOpen
        onClose={() => {}}
        onConfirm={onConfirm}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /open link/i }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('LinkSafetyModal — a link the seam refuses (DOR-547)', () => {
  it('says so in place, and makes copy the primary action', () => {
    // "Refusal message first" as a UI rule, not just a build order. Offering
    // "Open link" here would be a promise the next click breaks — the exact
    // confirm-then-decline shape this ticket was filed to remove, moved one
    // step later rather than fixed.
    render(
      <LinkSafetyModal
        url="irc://irc.example.com/dorkos"
        isOpen
        onClose={() => {}}
        onConfirm={() => {}}
      />
    );

    expect(screen.getByRole('dialog', { name: /doesn't open irc: links/i })).toBeInTheDocument();
    expect(screen.getByText("DorkOS doesn't open irc: links")).toBeInTheDocument();
    expect(
      screen.getByText("irc: links don't open from DorkOS, so nothing would happen.")
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open link/i })).toBeNull();
    expect(screen.getByRole('button', { name: /copy link/i })).toHaveClass(PRIMARY_CLASS);
  });

  it('still shows the address, which is the thing copy exists to hand over', () => {
    render(
      <LinkSafetyModal
        url="xmpp:someone@example.com"
        isOpen
        onClose={() => {}}
        onConfirm={() => {}}
      />
    );

    expect(screen.getByText('xmpp:someone@example.com')).toBeInTheDocument();
  });

  it('cannot be talked into confirming, because there is nothing to press', () => {
    const onConfirm = vi.fn();
    render(
      <LinkSafetyModal url="javascript:alert(1)" isOpen onClose={() => {}} onConfirm={onConfirm} />
    );

    screen.queryAllByRole('button', { name: /open link/i }).forEach((b) => fireEvent.click(b));

    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('falls back to the generic sentence for an address with no scheme to name', () => {
    render(<LinkSafetyModal url="http://" isOpen onClose={() => {}} onConfirm={() => {}} />);

    expect(screen.getByText(/address is incomplete/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open link/i })).toBeNull();
  });
});

describe('LinkSafetyModal — a link only THIS surface refuses (DOR-547 delta)', () => {
  afterEach(() => {
    delete window.electronAPI;
  });

  it('refuses a mailto: link in the desktop app, where the shell will not carry it', () => {
    // The composition bug this round fixes. `mailto:` clears `classifyLink`, so
    // a modal asking the surface-BLIND question drew "Open link" and then let
    // dispatch decline — promise-then-refuse, one step later than the shape
    // this ticket removed. `linkRefusalHere` asks the surface, so the button
    // and the outcome agree.
    window.electronAPI = { openExternal: vi.fn() } as unknown as ElectronAPI;

    render(
      <LinkSafetyModal url="mailto:hi@dorkos.ai" isOpen onClose={() => {}} onConfirm={() => {}} />
    );

    expect(screen.queryByRole('button', { name: /open link/i })).toBeNull();
    expect(screen.getByRole('button', { name: /copy link/i })).toHaveClass(PRIMARY_CLASS);
    expect(screen.getByText("The desktop app can't open mailto: links")).toBeInTheDocument();
    // Names the right policy. "DorkOS doesn't open mailto: links" would be
    // false — the web app does.
    expect(
      screen.getByText(
        'mailto: links open in a browser, but not in the desktop app, so nothing would happen.'
      )
    ).toBeInTheDocument();
  });

  it('still offers to open the same mailto: link with no desktop bridge in scope', () => {
    // The web app and the phone surface, where a browser genuinely carries it.
    // The desktop refusal above must stay a DESKTOP refusal.
    render(
      <LinkSafetyModal url="mailto:hi@dorkos.ai" isOpen onClose={() => {}} onConfirm={() => {}} />
    );

    expect(screen.getByRole('button', { name: /open link/i })).toHaveClass(PRIMARY_CLASS);
    expect(screen.getByText(/about to visit an external website/i)).toBeInTheDocument();
  });

  it('still offers to open an https link in the desktop app', () => {
    // The surface-aware gate must not swallow what the shell does carry.
    window.electronAPI = { openExternal: vi.fn() } as unknown as ElectronAPI;

    render(
      <LinkSafetyModal
        url="https://dorkos.ai/docs"
        isOpen
        onClose={() => {}}
        onConfirm={() => {}}
      />
    );

    expect(screen.getByRole('button', { name: /open link/i })).toHaveClass(PRIMARY_CLASS);
  });
});
