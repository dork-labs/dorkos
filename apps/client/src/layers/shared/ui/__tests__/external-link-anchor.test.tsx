/**
 * The anchor every externally-supplied URL renders through (DOR-924).
 *
 * The bug class this pins: a bare `<a href={someUrl}>` is followed by the
 * browser with none of our code running, so the app's scheme allowlist never
 * sees it. React neutralises a literal `javascript:` href; nothing neutralises
 * `data:`, `vbscript:`, `blob:` or the scheme nobody has named yet.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { toast } from 'sonner';
import { ExternalLinkAnchor } from '../external-link-anchor';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const open = vi.fn();

beforeEach(() => {
  open.mockReset();
  vi.mocked(toast.error).mockReset();
  vi.stubGlobal('open', open);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Every scheme the seam refuses that a supplier could realistically name. */
const HOSTILE = [
  'javascript:alert(1)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'blob:http://localhost:4242/9f2b',
  'file:///etc/passwd',
];

describe('ExternalLinkAnchor', () => {
  it('renders a real anchor for an https URL and dispatches it through the seam', () => {
    render(<ExternalLinkAnchor href="https://dorkos.ai/docs">Docs</ExternalLinkAnchor>);

    const link = screen.getByText('Docs');
    expect(link.getAttribute('href')).toBe('https://dorkos.ai/docs');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    // No `role="button"` shim: while the link is a link, it is a link.
    expect(link.hasAttribute('role')).toBe(false);

    fireEvent.click(link);
    expect(open).toHaveBeenCalledWith('https://dorkos.ai/docs', '_blank', 'noopener,noreferrer');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each(HOSTILE)('renders no href at all for %s, and refuses it out loud', (href) => {
    render(<ExternalLinkAnchor href={href}>Open</ExternalLinkAnchor>);

    const link = screen.getByText('Open');
    // The load-bearing assertion. Before this component the same string was
    // handed to the browser verbatim, so a middle-click or "Copy Link Address"
    // carried it away with nothing of ours in the path.
    expect(link.hasAttribute('href')).toBe(false);
    expect(link.getAttribute('role')).toBe('button');

    fireEvent.click(link);
    expect(open).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });

  it('answers Enter on a refused link, since there is no href for the browser to activate', () => {
    render(<ExternalLinkAnchor href="data:text/html,x">Open</ExternalLinkAnchor>);

    const link = screen.getByText('Open');
    expect(link.getAttribute('tabindex')).toBe('0');

    fireEvent.keyDown(link, { key: 'Enter' });
    expect(open).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });

  it('leaves a modified click on an http(s) link to the browser', () => {
    render(<ExternalLinkAnchor href="https://dorkos.ai/docs">Docs</ExternalLinkAnchor>);

    fireEvent.click(screen.getByText('Docs'), { metaKey: true });
    // The browser opens its own tab from the real href; the seam stays out of it.
    expect(open).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // `onOpened` — the property the whole callback exists for
  // -------------------------------------------------------------------------

  it('fires onOpened when the link actually left', () => {
    const onOpened = vi.fn();
    render(
      <ExternalLinkAnchor href="https://auth.example/authorize" onOpened={onOpened}>
        Open sign-in
      </ExternalLinkAnchor>
    );

    fireEvent.click(screen.getByText('Open sign-in'));
    expect(open).toHaveBeenCalled();
    expect(onOpened).toHaveBeenCalledTimes(1);
  });

  it.each(HOSTILE)('withholds onOpened when %s was refused', (href) => {
    // The load-bearing half. `onOpened` is what records "they opened the
    // sign-in page" and gates an "I finished signing in" affordance further
    // down the flow — firing it on a refusal is exactly how "nothing opened"
    // becomes "you're authorized".
    const onOpened = vi.fn();
    render(
      <ExternalLinkAnchor href={href} onOpened={onOpened}>
        Open sign-in
      </ExternalLinkAnchor>
    );

    fireEvent.click(screen.getByText('Open sign-in'));
    expect(open).not.toHaveBeenCalled();
    expect(onOpened).not.toHaveBeenCalled();
  });

  it('withholds onOpened on the keyboard path of a refused link too', () => {
    const onOpened = vi.fn();
    render(
      <ExternalLinkAnchor href="data:text/html,x" onOpened={onOpened}>
        Open sign-in
      </ExternalLinkAnchor>
    );

    fireEvent.keyDown(screen.getByText('Open sign-in'), { key: 'Enter' });
    expect(onOpened).not.toHaveBeenCalled();
  });

  it('fires onOpened for a modified click the browser takes', () => {
    // The browser opens its own tab from the real href, so the link did leave
    // — reporting otherwise would be the same lie in the other direction.
    const onOpened = vi.fn();
    render(
      <ExternalLinkAnchor href="https://auth.example/authorize" onOpened={onOpened}>
        Open sign-in
      </ExternalLinkAnchor>
    );

    fireEvent.click(screen.getByText('Open sign-in'), { metaKey: true });
    expect(open).not.toHaveBeenCalled();
    expect(onOpened).toHaveBeenCalledTimes(1);
  });

  it('forwards the attributes callers actually pass', () => {
    render(
      <ExternalLinkAnchor href="https://dorkos.ai" className="underline" aria-label="Homepage">
        dorkos.ai
      </ExternalLinkAnchor>
    );

    const link = screen.getByLabelText('Homepage');
    expect(link.className).toContain('underline');
  });
});
