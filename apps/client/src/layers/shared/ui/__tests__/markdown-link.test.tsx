// @vitest-environment jsdom
/**
 * `MarkdownLink` — the anchor every markdown surface in the app renders — and
 * specifically the question DOR-547 was filed about: does a confirmed click on
 * an agent-authored link clear the same gate as a confirmed click anywhere
 * else?
 *
 * Driven through the REAL `MarkdownContent` (and therefore the real
 * `streamdown` package) rather than by mounting `MarkdownLink` directly,
 * because half of what is under test is which hrefs reach the component at all:
 * Streamdown's sanitizer strips some schemes before an anchor exists, and the
 * seam refuses others after one is clicked. Only the end-to-end path can tell
 * those two apart. The two direct mounts below are labelled with why they have
 * to bypass the sanitizer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { toast } from 'sonner';
import { MarkdownContent } from '../markdown-content';
import { MarkdownLink } from '../markdown-link';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

let openSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.mocked(toast.error).mockClear();
  openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  openSpy.mockRestore();
  warnSpy.mockRestore();
});

/** Click the link, then press "Open link" in the confirmation that appears. */
function clickAndConfirm(name: string): void {
  fireEvent.click(screen.getByRole('link', { name }));
  fireEvent.click(screen.getByRole('button', { name: /open link/i }));
}

/**
 * Click the link and read back what the modal offers. A refused link has no
 * open button at all, so the confirm path above cannot be used on one.
 */
function clickAndInspect(name: string): { open: HTMLElement | null; copy: HTMLElement | null } {
  fireEvent.click(screen.getByRole('link', { name }));
  return {
    open: screen.queryByRole('button', { name: /open link/i }),
    copy: screen.queryByRole('button', { name: /copy link/i }),
  };
}

describe('MarkdownLink — a confirmed markdown link goes through the link seam (DOR-547)', () => {
  it('opens an https link, still', () => {
    render(<MarkdownContent content="Read [the docs](https://dorkos.ai/docs)" />);

    clickAndConfirm('the docs');

    expect(openSpy).toHaveBeenCalledWith('https://dorkos.ai/docs', '_blank', 'noopener,noreferrer');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('opens a tel: link, which the seam allows for the same reason it allows mailto:', () => {
    // The phone surface is a real one, and an agent writing a phone number as
    // a link produced a working link before this policy governed markdown.
    // `tel:` was added to `DISPATCHABLE_PROTOCOLS` with this change so that
    // stayed true; drop it from the allowlist and this goes red.
    render(<MarkdownContent content="Call [support](tel:+15551234567)" />);

    clickAndConfirm('support');

    expect(openSpy).toHaveBeenCalledWith('tel:+15551234567', '_blank', 'noopener,noreferrer');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('never offers to open an irc: link the markdown sanitizer let through', () => {
    // The whole divergence, in one case. `rehype-sanitize` permits `irc:`, so
    // the anchor is real and clickable; the seam refuses it, so the modal says
    // so instead of offering a button whose only outcome is a refusal.
    render(<MarkdownContent content="Join [the channel](irc://irc.example.com/dorkos)" />);

    const { open, copy } = clickAndInspect('the channel');

    expect(open).toBeNull();
    expect(copy).toBeInTheDocument();
    expect(screen.getByText(/DorkOS opens web, email and phone links/)).toBeInTheDocument();
    expect(screen.getByText(/This is a irc: link/)).toBeInTheDocument();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('never offers to open an xmpp: link either', () => {
    render(<MarkdownContent content="Chat on [xmpp](xmpp:someone@example.com)" />);

    expect(clickAndInspect('xmpp').open).toBeNull();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('refuses a file: href, which only a non-markdown caller can even supply', () => {
    // Mounted directly, because no caller can currently reach this: Streamdown
    // strips `file:` upstream, and `LinkifiedText` — the only other thing that
    // renders this component — emits `http(s)` matches and nothing else. This
    // is defense in depth against a THIRD caller, which is a one-line change
    // away, not coverage of a live path. Both of the gates that protect this
    // component today live in other files; this one is its own.
    render(<MarkdownLink href="file:///Users/kai/notes.md">notes</MarkdownLink>);

    expect(clickAndInspect('notes').open).toBeNull();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('refuses a javascript: href, which only a non-markdown caller can even supply', () => {
    render(<MarkdownLink href="javascript:alert(1)">totally safe</MarkdownLink>);

    expect(clickAndInspect('totally safe').open).toBeNull();
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('keeps the refusal wording sane for an absurdly long scheme', () => {
    // A refused href is agent-authored; `new URL` parses a scheme of any length.
    render(<MarkdownLink href={`${'a'.repeat(302)}://payload`}>click</MarkdownLink>);

    expect(clickAndInspect('click').open).toBeNull();
    expect(screen.queryByText(/This is a aaa/)).not.toBeInTheDocument();
    expect(screen.getByText(/address is incomplete/)).toBeInTheDocument();
  });
});

describe('MarkdownLink — schemes the markdown sanitizer strips never become links at all', () => {
  it.each([
    ['javascript:', '[click me](javascript:alert(1))'],
    ['data:', '[click me](data:text/html,<script>alert(1)</script>)'],
    ['vbscript:', '[click me](vbscript:msgbox(1))'],
    ['file:', '[click me](file:///Users/kai/notes.md)'],
    ['blob:', '[click me](blob:http://localhost:4242/9f2c)'],
  ])('%s renders as inert text, not an anchor', (_scheme, content) => {
    render(<MarkdownContent content={content} />);

    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
