// @vitest-environment jsdom
/**
 * The header block (BC-43, BC-44, BC-46).
 *
 * The load-bearing case here is `does not relayout`: the block is a switcher in
 * waiting, and the design's promise is that communities arrive as more rows in
 * this menu with nothing outside it moving. That is asserted by rendering the
 * real block against a three-row list and a six-row one and comparing the
 * block's own markup — not by describing the promise in a comment.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Settings } from 'lucide-react';
import { toast } from 'sonner';
import { OPERATOR_FALLBACK_DISPLAY_NAME } from '@dorkos/shared/team-schemas';
import type { SidebarMenuNode } from '@/layers/shared/ui';
import { buildHeaderBlockMenuNodes } from '../ui/header-block-menu';
import { SidebarHeaderBlock, teamNameFor } from '../ui/SidebarHeaderBlock';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let mockSelf: { id: string; displayName: string; isSelf: boolean } | null = {
  id: 'me',
  displayName: 'Dorian',
  isSelf: true,
};
vi.mock('@/layers/entities/team', () => ({
  useTeamRoster: () => ({ data: { members: mockSelf === null ? [] : [mockSelf] } }),
}));

const mockOpenSettings = vi.fn();
const mockOpenProfile = vi.fn();
const mockSetGlobalPaletteOpen = vi.fn();
let mockConfig: { version?: string; latestVersion?: string | null; isDevMode?: boolean } = {
  version: '0.58.0',
  latestVersion: null,
  isDevMode: false,
};
const mockGetConfig = vi.fn(() => Promise.resolve(mockConfig));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useTransport: () => ({ getConfig: mockGetConfig }),
    useSettingsDeepLink: () => ({ open: mockOpenSettings }),
    useProfileDeepLink: () => ({ open: mockOpenProfile }),
    useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
      selector({ setGlobalPaletteOpen: mockSetGlobalPaletteOpen }),
  };
});

// The New menu is the header block's neighbour, not its subject: it reaches for
// a router, a query client and the whole fleet, and `NewMenu.test.tsx` is where
// it is exercised. Marked here so its presence is still asserted.
vi.mock('../ui/NewMenu', () => ({ NewMenu: () => <div data-testid="new-menu" /> }));

/** Menu rows this render should show, or `null` for the real builder. */
let mockMenuNodes: SidebarMenuNode[] | null = null;
vi.mock('../ui/header-block-menu', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui/header-block-menu')>();
  return {
    ...actual,
    buildHeaderBlockMenuNodes: (model: Parameters<typeof actual.buildHeaderBlockMenuNodes>[0]) =>
      mockMenuNodes ?? actual.buildHeaderBlockMenuNodes(model),
  };
});

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
  vi.clearAllMocks();
  mockSelf = { id: 'me', displayName: 'Dorian', isSelf: true };
  mockConfig = { version: '0.58.0', latestVersion: null, isDevMode: false };
  mockMenuNodes = null;
});

afterEach(() => cleanup());

function renderBlock() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SidebarHeaderBlock />
    </QueryClientProvider>
  );
}

/**
 * The header block's own markup, with Radix's per-render ids neutralised.
 *
 * Those ids are a counter, not a layout: they differ between any two renders of
 * the same tree, so leaving them in would make this comparison fail for a
 * reason that has nothing to do with the claim. Everything else — structure,
 * every class, every attribute — is compared verbatim.
 */
function blockMarkup(): string {
  const root = screen.getByTestId('sidebar-header-block').closest('[data-slot]');
  if (root === null) throw new Error('header block has no slot root');
  return root.outerHTML.replace(/radix-[\w-]+/g, 'radix-id');
}

/** N interchangeable menu rows — the stand-in for "communities shipped". */
function rows(count: number): SidebarMenuNode[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: 'action' as const,
    id: `row-${i}`,
    label: `Row ${i}`,
    icon: Settings,
    opensInput: false,
    run: () => {},
  }));
}

// ---------------------------------------------------------------------------
// The menu, as data
// ---------------------------------------------------------------------------

describe('buildHeaderBlockMenuNodes', () => {
  const base = {
    onOpenSettings: () => {},
    onOpenAccount: () => {},
    version: '0.58.0',
    isDevMode: false,
    onCheckForUpdates: () => {},
  };

  it('carries Workspace settings, Account and the version line, in that order', () => {
    expect(buildHeaderBlockMenuNodes(base).map((n) => n.id)).toEqual([
      'workspace-settings',
      'account',
      'sep-version',
      'version',
    ]);
  });

  it('spells the version line the way the design does', () => {
    const version = buildHeaderBlockMenuNodes(base).find((n) => n.id === 'version');
    expect(version).toMatchObject({ label: 'v0.58.0 beta', hint: 'Check for updates' });
  });

  it('drops Account when the roster names nobody, rather than offering a dead row', () => {
    expect(
      buildHeaderBlockMenuNodes({ ...base, onOpenAccount: null }).map((n) => n.id)
    ).not.toContain('account');
  });

  it('says "Development build" instead of a number nobody can update to', () => {
    const nodes = buildHeaderBlockMenuNodes({ ...base, isDevMode: true });
    expect(nodes.find((n) => n.id === 'version')).toMatchObject({
      kind: 'note',
      text: 'Development build',
    });
  });

  it('withholds the version line entirely until the server has answered', () => {
    expect(buildHeaderBlockMenuNodes({ ...base, version: null }).map((n) => n.id)).not.toContain(
      'version'
    );
  });

  it('says "workspace" once, and only where it names the settings surface', () => {
    const said = buildHeaderBlockMenuNodes(base)
      .filter((n) => n.kind === 'action' || n.kind === 'note')
      .map((n) => (n.kind === 'note' ? n.text : n.label))
      .filter((text) => /workspace/i.test(text));
    expect(said).toEqual(['Workspace settings']);
  });
});

// ---------------------------------------------------------------------------
// The block itself
// ---------------------------------------------------------------------------

describe('teamNameFor', () => {
  it('names the cockpit after the operator', () => {
    expect(teamNameFor('Dorian')).toBe("Dorian's team");
  });

  it('does not double the s on a name that already ends in one', () => {
    expect(teamNameFor('Chris')).toBe("Chris' team");
  });

  it('falls back to a name it can say honestly when the roster is empty', () => {
    expect(teamNameFor(null)).toBe('Your team');
    expect(teamNameFor('  ')).toBe('Your team');
  });

  it('does not say "You\u2019s team" before the operator has given a name', () => {
    // The roster answers with the literal 'You' until Settings › Profile is
    // filled in. A browser run caught this one, not a test.
    expect(teamNameFor(OPERATOR_FALLBACK_DISPLAY_NAME)).toBe('Your team');
  });
});

describe('SidebarHeaderBlock', () => {
  it('is a button named after the operator, with the New button and the ⌘K pill beside it', () => {
    renderBlock();
    const block = screen.getByRole('button', { name: /Dorian's team/ });
    expect(block.tagName).toBe('BUTTON');
    expect(block).toHaveTextContent("Dorian's team");
    expect(screen.getByTestId('new-menu')).toBeInTheDocument();
    expect(screen.getByTestId('sidebar-search-pill')).toBeInTheDocument();
  });

  it('says "workspace" nowhere in the block itself — not even to a screen reader', async () => {
    renderBlock();
    // Observable first: the block IS rendered and DOES carry an accessible
    // name, so the absence below is about the wording and not about an empty
    // document.
    const block = screen.getByTestId('sidebar-header-block');
    expect(block.getAttribute('aria-label')).toMatch(/team/);
    expect(block.outerHTML).not.toMatch(/workspace/i);

    // …and inside the menu it is said exactly once, naming the settings
    // surface that already carries that word (§16, R4).
    fireEvent.pointerDown(block);
    const menu = await screen.findByRole('menu');
    expect(menu.textContent?.match(/workspace/gi)).toHaveLength(1);
  });

  it('opens the settings dialog from Workspace settings', async () => {
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Workspace settings…' }));
    expect(mockOpenSettings).toHaveBeenCalledOnce();
  });

  it('opens your own profile from Account', async () => {
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Account…' }));
    expect(mockOpenProfile).toHaveBeenCalledWith('me');
  });

  it('shows the running version in the menu once the server answers', async () => {
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    expect(await screen.findByRole('menuitem', { name: /v0\.58\.0 beta/ })).toBeInTheDocument();
  });

  it('grows the menu without moving anything outside it (BC-43)', async () => {
    // Three rows.
    mockMenuNodes = rows(3);
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    await screen.findByRole('menuitem', { name: 'Row 0' });
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(3);
    const short = blockMarkup();
    cleanup();

    // Six — what "communities shipped" looks like from out here.
    mockMenuNodes = rows(6);
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    await screen.findByRole('menuitem', { name: 'Row 5' });
    // The menu really did get longer — otherwise the comparison below is a
    // comparison of two identical renders and proves nothing.
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(6);

    expect(blockMarkup()).toBe(short);
  });

  it('asks the server again when you check for updates, and reports being current', async () => {
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    await screen.findByRole('menuitem', { name: /v0\.58\.0 beta/ });
    const asked = mockGetConfig.mock.calls.length;

    fireEvent.click(screen.getByRole('menuitem', { name: /v0\.58\.0 beta/ }));

    await waitFor(() => expect(mockGetConfig.mock.calls.length).toBeGreaterThan(asked));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("You're up to date"));
  });

  it('names the newer release when the server has one', async () => {
    mockConfig = { version: '0.58.0', latestVersion: '0.59.0', isDevMode: false };
    renderBlock();
    fireEvent.pointerDown(screen.getByTestId('sidebar-header-block'));
    fireEvent.click(await screen.findByRole('menuitem', { name: /v0\.58\.0 beta/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Version 0.59.0 is available'));
  });
});
