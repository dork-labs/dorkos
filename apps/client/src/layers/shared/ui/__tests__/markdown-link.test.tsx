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
import { registerLinkNavigator, type LinkNavigation } from '../../lib/link-navigation';

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
    expect(screen.getByText('DorkOS doesn’t open irc: links')).toBeInTheDocument();
    expect(screen.getByText('Only web, email and phone links open.')).toBeInTheDocument();
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
    // The heading and the sentence stay generic. The address block below them
    // still shows the whole thing, deliberately — that is what "Copy link"
    // hands over, and it wraps.
    expect(screen.getByText('DorkOS couldn’t open that link')).toBeInTheDocument();
    expect(screen.getByText('It isn’t a web, email or phone link.')).toBeInTheDocument();
  });

  it('still names a long-but-real OAuth scheme, which is who this message is for', () => {
    // Reverse-DNS sign-in schemes run past any tight clamp, and an MCP server
    // naming one is exactly the case worth explaining rather than generalising.
    render(<MarkdownLink href="com.mycompany.myapp.oauth://authorize">sign in</MarkdownLink>);

    expect(clickAndInspect('sign in').open).toBeNull();
    expect(
      screen.getByText('DorkOS doesn’t open com.mycompany.myapp.oauth: links')
    ).toBeInTheDocument();
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

describe('MarkdownLink — a link to one of the app’s own pages opens without asking (DOR-2824)', () => {
  let navigated: LinkNavigation[];
  let unregister: () => void;

  beforeEach(() => {
    navigated = [];
    unregister = registerLinkNavigator((navigation) => navigated.push(navigation));
  });

  afterEach(() => unregister());

  function modalShown(): boolean {
    return screen.queryByRole('dialog') !== null;
  }

  it('opens a chat link in place, through the router, with no confirm', () => {
    render(
      <MarkdownContent content="See [Rooms: always answer people](/session?session=abc-123)" />
    );

    fireEvent.click(screen.getByRole('link', { name: 'Rooms: always answer people' }));

    expect(navigated).toEqual([{ href: '/session?session=abc-123', replace: undefined }]);
    expect(modalShown()).toBe(false);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('opens an absolute link at our own origin in place too', () => {
    const href = `${window.location.origin}/session?session=abc-123`;
    render(<MarkdownLink href={href}>the chat</MarkdownLink>);

    fireEvent.click(screen.getByRole('link', { name: 'the chat' }));

    expect(navigated).toEqual([{ href: '/session?session=abc-123', replace: undefined }]);
    expect(modalShown()).toBe(false);
  });

  it.each([
    ['cmd', { metaKey: true }],
    ['ctrl', { ctrlKey: true }],
  ])('opens it in a new tab on %s-click, with no confirm', (_key, modifier) => {
    render(<MarkdownContent content="See [the chat](/session?session=abc-123)" />);

    fireEvent.click(screen.getByRole('link', { name: 'the chat' }), modifier);

    expect(navigated).toEqual([]);
    expect(openSpy).toHaveBeenCalledWith(
      `${window.location.origin}/session?session=abc-123`,
      '_blank'
    );
    expect(modalShown()).toBe(false);
  });

  it('still confirms an external link', () => {
    render(<MarkdownContent content="Read [the docs](https://dorkos.ai/docs)" />);

    fireEvent.click(screen.getByRole('link', { name: 'the docs' }));

    expect(modalShown()).toBe(true);
    expect(navigated).toEqual([]);
  });

  it.each([
    ['an API path', '/api/sessions'],
    ['a path that normalises onto the API', '/session/../api/sessions'],
    ['a protocol-relative host', '//evil.example/session?session=abc'],
    ['an extension page', '/x/some-extension/page'],
    ['a launch link that would send as you', '/session?agentId=a&prompt=delete%20it&send=1'],
  ])('still confirms a crafted relative link: %s', (_label, href) => {
    render(<MarkdownLink href={href}>crafted</MarkdownLink>);

    fireEvent.click(screen.getByRole('link', { name: 'crafted' }));

    expect(modalShown()).toBe(true);
    expect(navigated).toEqual([]);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('never hands a launch link to the browser on cmd-click, even absolute', () => {
    const href = `${window.location.origin}/session?agentId=a&prompt=hi&send=1`;
    render(<MarkdownLink href={href}>launch</MarkdownLink>);

    fireEvent.click(screen.getByRole('link', { name: 'launch' }), { metaKey: true });

    expect(modalShown()).toBe(true);
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('stops a middle click on a launch link, and leaves one on a chat link to the browser', () => {
    render(
      <>
        <MarkdownLink href="/session?agentId=a&prompt=hi&send=1">launch</MarkdownLink>
        <MarkdownLink href="/session?session=abc">chat</MarkdownLink>
      </>
    );

    const launch = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
    screen.getByRole('link', { name: 'launch' }).dispatchEvent(launch);
    const chat = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
    screen.getByRole('link', { name: 'chat' }).dispatchEvent(chat);

    expect(launch.defaultPrevented).toBe(true);
    expect(chat.defaultPrevented).toBe(false);
  });
});
