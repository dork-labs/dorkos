// @vitest-environment jsdom
/**
 * `LinkSafetyModal` — the confirmation every untrusted link in the app renders
 * through (`MarkdownLink`, gen-UI widget `url` actions, MCP App iframes).
 *
 * The behaviour under test is DOR-547's design ruling: the modal asks the link
 * seam BEFORE it offers to open anything, so a scheme `classifyLink` refuses
 * never gets a button whose only possible outcome is a refusal.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { LinkSafetyModal } from '../link-safety-modal';

afterEach(() => cleanup());

/** The class the design system uses for the one primary action in a dialog. */
const PRIMARY_CLASS = 'bg-foreground';

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

    expect(screen.getByRole('dialog', { name: /cannot be opened/i })).toBeInTheDocument();
    expect(screen.getByText(/DorkOS can't open this link/)).toBeInTheDocument();
    expect(screen.getByText(/This is a irc: link/)).toBeInTheDocument();
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
