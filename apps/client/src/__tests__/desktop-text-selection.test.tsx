// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { Button, MarkdownContent, MentionPill, SidebarMenuButton } from '@/layers/shared/ui';

/**
 * In the desktop app, text a person reads can be selected and copied, and app
 * chrome cannot (DOR-2871).
 *
 * The desktop shell used to set `user-select: none` on the whole `<body>` and
 * ask every content surface to opt back in. Most never did, so a mini-app page,
 * a settings line or an agent profile could not be copied at all. The default
 * is now flipped: text is selectable, and only chrome (buttons, tabs, menu
 * items, sidebar rows, resize handles, the title bar) opts out.
 *
 * jsdom neither loads `index.css` nor inherits `user-select`, so this reads the
 * real rules out of the stylesheet, plus the Tailwind `select-*` utilities, and
 * resolves the value the way a browser does: the element's own winning rule
 * first (unlayered over `utilities` over `base`, then source order), else its
 * parent's. A renamed selector fails here instead of on someone's Mac.
 */
const indexCss = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../index.css'),
  'utf8'
);

/** Cascade tier: unlayered beats `@layer utilities` beats `@layer base`. */
type Tier = 1 | 2 | 3;

interface SelectRule {
  selector: string;
  value: string;
  tier: Tier;
  order: number;
}

/**
 * Every rule in `index.css` that sets `user-select`, with its layer tier.
 *
 * A small brace scanner, not a parser: CSS comments are skipped as it walks
 * (they hold braces and selectors in prose), and nothing else in this file
 * nests deeper than `@layer` or `@media`.
 */
function stylesheetRules(): SelectRule[] {
  const rules: SelectRule[] = [];
  const preludes: string[] = [];
  let buffer = '';
  let hadChildBlock = false;
  for (let i = 0; i < indexCss.length; i++) {
    const ch = indexCss[i];
    if (ch === '/' && indexCss[i + 1] === '*') {
      const end = indexCss.indexOf('*/', i + 2);
      i = end === -1 ? indexCss.length : end + 1;
    } else if (ch === '{') {
      preludes.push(buffer.trim().replace(/\s+/g, ' '));
      buffer = '';
      hadChildBlock = false;
    } else if (ch === '}') {
      const prelude = preludes.pop() ?? '';
      const value = /(?:^|;)\s*user-select:\s*([a-z]+)/.exec(buffer)?.[1];
      if (!hadChildBlock && value && !prelude.startsWith('@')) {
        const layer = preludes.find((p) => p.startsWith('@layer'));
        const tier: Tier = !layer ? 3 : layer.includes('utilities') ? 2 : 1;
        rules.push({ selector: prelude, value, tier, order: rules.length });
      }
      buffer = '';
      hadChildBlock = true;
    } else {
      buffer += ch;
    }
  }
  return rules;
}

const RULES = stylesheetRules();

/** Tailwind's `select-*` utilities, with and without the `desktop:` variant. */
function utilityValue(el: Element): string | undefined {
  const onDesktop = el.closest('.desktop') !== null;
  let value: string | undefined;
  for (const cls of el.classList) {
    const match = /^(desktop:)?select-(none|text|all|auto)$/.exec(cls);
    if (match && (!match[1] || onDesktop)) value = match[2];
  }
  return value;
}

/** The `user-select` that wins on this element alone, if any rule sets one. */
function ownValue(el: Element): string | undefined {
  const matched = RULES.filter((r) => el.matches(r.selector));
  const utility = utilityValue(el);
  const candidates = [...matched];
  if (utility) candidates.push({ selector: '', value: utility, tier: 2, order: Infinity });
  candidates.sort((a, b) => a.tier - b.tier || a.order - b.order);
  return candidates.at(-1)?.value;
}

/** The `user-select` a browser would apply, walking up through inheritance. */
function effectiveUserSelect(el: Element): string {
  for (let node: Element | null = el; node; node = node.parentElement) {
    const value = ownValue(node);
    if (value && value !== 'auto') return value;
  }
  return 'auto';
}

function isSelectable(el: Element): boolean {
  return effectiveUserSelect(el) !== 'none';
}

describe('desktop text selection (index.css, DOR-2871)', () => {
  beforeEach(() => {
    document.documentElement.classList.add('desktop');
  });

  afterEach(() => {
    cleanup();
    document.documentElement.classList.remove('desktop');
  });

  it('found the stylesheet rules it checks', () => {
    expect(RULES.length).toBeGreaterThan(0);
  });

  describe('text a person reads is selectable', () => {
    it('a mini-app page, with no opt-in of its own', () => {
      render(
        <div data-testid="extension-page">
          <pre>
            <code>pnpm run build</code>
          </pre>
          <p>Finish the release checklist.</p>
        </div>
      );
      expect(isSelectable(screen.getByText('pnpm run build'))).toBe(true);
      expect(isSelectable(screen.getByText('Finish the release checklist.'))).toBe(true);
    });

    it('a settings line and an agent profile line', () => {
      render(
        <section>
          <h2>Server</h2>
          <p>Runs on port 4300.</p>
        </section>
      );
      expect(isSelectable(screen.getByText('Server'))).toBe(true);
      expect(isSelectable(screen.getByText('Runs on port 4300.'))).toBe(true);
    });

    it('markdown prose and code in a message or the canvas', () => {
      render(<MarkdownContent content={'Run this:\n\n```sh\necho hello\n```'} />);
      expect(isSelectable(screen.getByText('Run this:'))).toBe(true);
      expect(isSelectable(screen.getByText(/echo hello/))).toBe(true);
    });

    it('a mention inside a message, so a copied message keeps its names', () => {
      render(
        <p>
          Ask <MentionPill kind="agent" label="scout" resolved role="button" tabIndex={0} /> to
          review it.
        </p>
      );
      expect(isSelectable(screen.getByRole('button', { name: /scout/ }))).toBe(true);
    });

    it('a toast', () => {
      render(<li data-sonner-toast="">Couldn’t reach Telegram.</li>);
      expect(isSelectable(screen.getByText('Couldn’t reach Telegram.'))).toBe(true);
    });

    it('a field inside the title bar', () => {
      render(
        <header className="app-drag-region">
          <input aria-label="Search" />
        </header>
      );
      expect(effectiveUserSelect(screen.getByLabelText('Search'))).toBe('text');
    });
  });

  describe('app chrome is not selectable', () => {
    it('a button label', () => {
      render(<Button>Save</Button>);
      expect(isSelectable(screen.getByText('Save'))).toBe(false);
    });

    it('a sidebar row, as a button or a link', () => {
      render(
        <>
          <SidebarMenuButton>Inbox</SidebarMenuButton>
          <SidebarMenuButton asChild>
            <a href="/team">Team</a>
          </SidebarMenuButton>
        </>
      );
      expect(isSelectable(screen.getByText('Inbox'))).toBe(false);
      expect(isSelectable(screen.getByText('Team'))).toBe(false);
    });

    it('tabs, menu items and options', () => {
      render(
        <>
          <div role="tab">Files</div>
          <div role="menuitem">Rename</div>
          <div role="option" aria-selected="false">
            Scout
          </div>
        </>
      );
      expect(isSelectable(screen.getByText('Files'))).toBe(false);
      expect(isSelectable(screen.getByText('Rename'))).toBe(false);
      expect(isSelectable(screen.getByText('Scout'))).toBe(false);
    });

    it('a resize handle and the title bar', () => {
      render(
        <>
          <div role="separator" aria-orientation="vertical" data-testid="handle" />
          <header className="app-drag-region">
            <span>Inbox</span>
          </header>
        </>
      );
      expect(isSelectable(screen.getByTestId('handle'))).toBe(false);
      expect(isSelectable(screen.getByText('Inbox'))).toBe(false);
    });
  });

  it('leaves the web app alone: no desktop class, no rule applies', () => {
    document.documentElement.classList.remove('desktop');
    render(<Button>Save</Button>);
    expect(effectiveUserSelect(screen.getByText('Save'))).toBe('auto');
  });
});
