/**
 * @vitest-environment jsdom
 */
/**
 * `LinkifiedText` — the renderer for untrusted machine output (runtime errors,
 * adapter failures). Two properties matter and both are asserted here: bare
 * `http(s)` URLs become real, confirm-before-navigate anchors, and NOTHING else
 * in the string is interpreted — no markdown, no HTML.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { LinkifiedText, splitOnUrls } from '../linkified-text';

afterEach(() => cleanup());

describe('LinkifiedText — bare URLs become real anchors', () => {
  it('renders a bare https URL as an `<a href>` whose label is the URL', () => {
    render(
      <p>
        <LinkifiedText text="Add credits at https://openrouter.ai/settings/credits" />
      </p>
    );

    const link = screen.getByRole('link', { name: 'https://openrouter.ai/settings/credits' });
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', 'https://openrouter.ai/settings/credits');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('rel')).toContain('noreferrer');
  });

  it('keeps the surrounding words as text', () => {
    const { container } = render(
      <p>
        <LinkifiedText text="Add credits at https://openrouter.ai/settings/credits and retry" />
      </p>
    );

    expect(container.textContent).toBe(
      'Add credits at https://openrouter.ai/settings/credits and retry'
    );
  });

  it('links every URL in a multi-URL string', () => {
    render(
      <p>
        <LinkifiedText text="See http://a.example/one then https://b.example/two" />
      </p>
    );

    expect(screen.getAllByRole('link')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'http://a.example/one' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'https://b.example/two' })).toBeInTheDocument();
  });

  it('an unmodified left click opens the shared safety confirmation', () => {
    render(
      <p>
        <LinkifiedText text="Visit https://dorkos.ai/docs" />
      </p>
    );

    const notPrevented = fireEvent.click(screen.getByRole('link', { name: /dorkos/ }));

    expect(notPrevented).toBe(false);
    expect(screen.getByRole('dialog', { name: /open external link/i })).toBeInTheDocument();
  });

  it('a cmd-clicked http(s) link is left to the browser', () => {
    render(
      <p>
        <LinkifiedText text="Visit https://dorkos.ai/docs" />
      </p>
    );

    const notPrevented = fireEvent.click(screen.getByRole('link', { name: /dorkos/ }), {
      metaKey: true,
    });

    expect(notPrevented).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('LinkifiedText — untrusted text is never interpreted', () => {
  it('does not render raw HTML from the error string', () => {
    const { container } = render(
      <p>
        <LinkifiedText text={'<img src=x onerror=alert(1)> <b>bold</b> <script>evil()</script>'} />
      </p>
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toBe(
      '<img src=x onerror=alert(1)> <b>bold</b> <script>evil()</script>'
    );
  });

  it('does not interpret markdown — no emphasis, headings, or code spans', () => {
    const { container } = render(
      <p>
        <LinkifiedText text={'# Heading **bold** `code` _under_score_ - item'} />
      </p>
    );

    expect(container.querySelector('strong')).toBeNull();
    expect(container.querySelector('em')).toBeNull();
    expect(container.querySelector('code')).toBeNull();
    expect(container.querySelector('h1')).toBeNull();
    expect(container.querySelector('li')).toBeNull();
    expect(container.textContent).toBe('# Heading **bold** `code` _under_score_ - item');
  });

  it('cannot produce a link whose label disagrees with its destination', () => {
    // The spoofing shape markdown would allow: a friendly label over a hostile
    // href. Rendered here, each anchor is labelled by its own destination, so
    // the decoy and the real target are two visibly separate links.
    render(
      <p>
        <LinkifiedText text="[https://dorkos.ai/settings](https://attacker.example/steal)" />
      </p>
    );

    // Named destinations, not `link.textContent` compared against itself —
    // that assertion could only fail under a total rewrite and was no evidence
    // of the property it claimed (DOR-1661 review, nit 3).
    expect(screen.getByRole('link', { name: 'https://dorkos.ai/settings' })).toHaveAttribute(
      'href',
      'https://dorkos.ai/settings'
    );
    expect(screen.getByRole('link', { name: 'https://attacker.example/steal' })).toHaveAttribute(
      'href',
      'https://attacker.example/steal'
    );
  });

  it('stops a URL at a bracket so markdown link syntax cannot fuse two hosts', () => {
    expect(splitOnUrls('[https://good.example/a](https://bad.example/b)')).toEqual([
      { kind: 'text', value: '[' },
      { kind: 'link', url: 'https://good.example/a' },
      { kind: 'text', value: '](' },
      { kind: 'link', url: 'https://bad.example/b' },
      { kind: 'text', value: ')' },
    ]);
  });

  it('leaves non-http(s) schemes as plain text', () => {
    const { container } = render(
      <p>
        <LinkifiedText text="javascript:alert(1) file:///etc/passwd mailto:a@b.example" />
      </p>
    );

    expect(container.querySelector('a')).toBeNull();
  });
});

describe('LinkifiedText — the label is the destination, after normalization', () => {
  // The browser normalizes an href before requesting it, so a label that is
  // character-for-character the provider's raw string can still name a
  // different host than the one it opens. Each case below renders the
  // NORMALIZED form, so the lie is visible in the label itself.
  it.each([
    // Cyrillic о (U+043E) — reads "dorkos.ai", resolves to punycode.
    ['https://d\u043erkos.ai/settings', 'https://xn--drkos-jye.ai/settings'],
    // U+3002 ideographic full stop maps to "." under UTS46.
    ['https://dorkos.ai\u3002evil.example/x', 'https://dorkos.ai.evil.example/x'],
    // U+202E right-to-left override renders "gnp.exe" as "exe.png".
    ['https://good.example/\u202egnp.exe', 'https://good.example/%E2%80%AEgnp.exe'],
  ])('renders %s as its real destination', (raw, expected) => {
    render(
      <p>
        <LinkifiedText text={`Sign in at ${raw}`} />
      </p>
    );

    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', expected);
    // The label and the href agree — that is the whole invariant.
    expect(link).toHaveTextContent(expected);
  });

  it('refuses to link a URL that carries credentials', () => {
    // Normalization alone does NOT fix this shape: `https://dorkos.ai@evil.example`
    // normalizes to itself while resolving to `evil.example`, so a reader still
    // reads the decoy first. Left as text instead.
    const { container } = render(
      <p>
        <LinkifiedText text="Sign in at https://dorkos.ai@evil.example/settings" />
      </p>
    );

    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('Sign in at https://dorkos.ai@evil.example/settings');
  });

  it('leaves ordinary URLs looking like themselves', () => {
    render(
      <p>
        <LinkifiedText text="Top up at https://openrouter.ai/settings/credits" />
      </p>
    );

    expect(
      screen.getByRole('link', { name: 'https://openrouter.ai/settings/credits' })
    ).toHaveAttribute('href', 'https://openrouter.ai/settings/credits');
  });
});

describe('splitOnUrls — a hostile tail cannot freeze the tab', () => {
  it('trims a 40,000-character closing-paren run in linear time', () => {
    // `)` and `}` are not excluded from the scanner, so one match can end in an
    // arbitrarily long run of them. The original trimmer recounted both
    // brackets across the whole remaining string per character removed — O(n²),
    // measured at 19.4s for this exact input, inside a `useMemo` during render
    // (DOR-1661 review, red 1). The budget below is ~10x the linear cost and
    // ~0.1x the quadratic one, so it discriminates even on a loaded machine.
    const text = `Error: https://a.example${')'.repeat(40_000)}`;

    const startedAt = performance.now();
    const segments = splitOnUrls(text);
    const elapsedMs = performance.now() - startedAt;

    expect(segments).toEqual([
      { kind: 'text', value: 'Error: ' },
      { kind: 'link', url: 'https://a.example/' },
      { kind: 'text', value: ')'.repeat(40_000) },
    ]);
    expect(elapsedMs).toBeLessThan(2000);
  });

  it('is linear in a closing-brace run too', () => {
    const segments = splitOnUrls(`https://a.example${'}'.repeat(20_000)}`);
    expect(segments).toEqual([
      { kind: 'link', url: 'https://a.example/' },
      { kind: 'text', value: '}'.repeat(20_000) },
    ]);
  });
});

describe('splitOnUrls — boundary trimming', () => {
  it('leaves a string with no URL as a single text segment', () => {
    expect(splitOnUrls('nothing to see')).toEqual([{ kind: 'text', value: 'nothing to see' }]);
  });

  it('drops a sentence-ending full stop from the URL', () => {
    expect(splitOnUrls('Go to https://dorkos.ai/docs.')).toEqual([
      { kind: 'text', value: 'Go to ' },
      { kind: 'link', url: 'https://dorkos.ai/docs' },
      { kind: 'text', value: '.' },
    ]);
  });

  it('drops an unbalanced closing paren but keeps a balanced one', () => {
    expect(splitOnUrls('(see https://dorkos.ai/docs)')).toEqual([
      { kind: 'text', value: '(see ' },
      { kind: 'link', url: 'https://dorkos.ai/docs' },
      { kind: 'text', value: ')' },
    ]);
    expect(splitOnUrls('https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual([
      { kind: 'link', url: 'https://en.wikipedia.org/wiki/Foo_(bar)' },
    ]);
  });

  it('does not link a scheme with no host', () => {
    expect(splitOnUrls('https:// is not a URL')).toEqual([
      { kind: 'text', value: 'https:// is not a URL' },
    ]);
  });

  it('stops a URL at a quote so a quoted URL keeps its delimiter', () => {
    expect(splitOnUrls('open "https://dorkos.ai/docs" now')).toEqual([
      { kind: 'text', value: 'open "' },
      { kind: 'link', url: 'https://dorkos.ai/docs' },
      { kind: 'text', value: '" now' },
    ]);
  });
});
