/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { Settings, User, Bell } from 'lucide-react';
import { TabbedDialog, type TabbedDialogTab } from '../tabbed-dialog';
import type { SettingsTabContribution } from '@/layers/shared/model';

// ---------------------------------------------------------------------------
// Mock: useIsMobile + useSlotContributions
// ---------------------------------------------------------------------------

const mockUseSlotContributions = vi.fn<() => SettingsTabContribution[]>(() => []);

vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useIsMobile: () => false,
  useSlotContributions: () => mockUseSlotContributions(),
}));

// ---------------------------------------------------------------------------
// Mock: dialog + drawer (required by ResponsiveDialog → ResponsiveDialogContent)
// ---------------------------------------------------------------------------

vi.mock('../dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open !== false ? <div data-testid="dialog-root">{children}</div> : null,
  DialogContent: ({
    children,
    className,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & { children: React.ReactNode }) => (
    <div data-testid="dialog-content" className={className} {...props}>
      {children}
    </div>
  ),
  DialogTitle: ({ children, className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h2 className={className} {...props}>
      {children}
    </h2>
  ),
  DialogDescription: ({
    children,
    className,
    ...props
  }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p className={className} {...props}>
      {children}
    </p>
  ),
  DialogClose: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLButtonElement> & { children?: React.ReactNode }) => (
    <button {...props}>{children}</button>
  ),
  DialogHeader: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DialogFooter: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DialogTrigger: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLButtonElement> & { children?: React.ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock('../drawer', () => ({
  Drawer: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open !== false ? <div data-testid="drawer-root">{children}</div> : null,
  DrawerContent: ({
    children,
    className,
    ...props
  }: React.HTMLAttributes<HTMLDivElement> & { children: React.ReactNode }) => (
    <div data-testid="drawer-content" className={className} {...props}>
      {children}
    </div>
  ),
  DrawerClose: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLButtonElement> & { children?: React.ReactNode }) => (
    <button {...props}>{children}</button>
  ),
  DrawerTitle: ({ children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <h2 {...props}>{children}</h2>
  ),
  DrawerDescription: ({ children, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <p {...props}>{children}</p>
  ),
  DrawerHeader: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DrawerFooter: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
    <div {...props}>{children}</div>
  ),
  DrawerTrigger: ({
    children,
    ...props
  }: React.HTMLAttributes<HTMLButtonElement> & { children?: React.ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));

// ---------------------------------------------------------------------------
// matchMedia shim (required by jsdom)
// ---------------------------------------------------------------------------

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  mockUseSlotContributions.mockReturnValue([]);
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type TabId = 'alpha' | 'beta' | 'gamma';

const TabAlpha = () => <div data-testid="panel-alpha">Alpha content</div>;
const TabBeta = () => <div data-testid="panel-beta">Beta content</div>;
const TabGamma = () => <div data-testid="panel-gamma">Gamma content</div>;

const MOCK_TABS: TabbedDialogTab<TabId>[] = [
  { id: 'alpha', label: 'Alpha', icon: Settings, component: TabAlpha },
  { id: 'beta', label: 'Beta', icon: User, component: TabBeta },
  { id: 'gamma', label: 'Gamma', icon: Bell, component: TabGamma },
];

interface RenderOptions {
  open?: boolean;
  initialTab?: TabId | null;
  defaultTab?: TabId;
  sidebarExtras?: React.ReactNode;
  extensionSlot?: 'settings.tabs';
  maxWidth?: string;
  minHeight?: string;
  maximized?: boolean;
  testId?: string;
  tabs?: TabbedDialogTab<TabId>[];
  headerSlot?: React.ReactNode;
  description?: string;
  title?: React.ReactNode;
}

function renderDialog(options: RenderOptions = {}) {
  const {
    open = true,
    initialTab,
    defaultTab = 'alpha',
    sidebarExtras,
    extensionSlot,
    maxWidth,
    minHeight,
    maximized,
    testId,
    tabs = MOCK_TABS,
    headerSlot,
    description,
    title = 'Test Dialog',
  } = options;

  const onOpenChange = vi.fn();

  const result = render(
    <TabbedDialog<TabId>
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      headerSlot={headerSlot}
      defaultTab={defaultTab}
      initialTab={initialTab}
      tabs={tabs}
      sidebarExtras={sidebarExtras}
      extensionSlot={extensionSlot}
      maxWidth={maxWidth}
      minHeight={minHeight}
      maximized={maximized}
      testId={testId}
    />
  );

  return { ...result, onOpenChange };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TabbedDialog', () => {
  it('renders all built-in tabs in the sidebar', () => {
    renderDialog();
    expect(screen.getByRole('tab', { name: /alpha/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /beta/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /gamma/i })).toBeInTheDocument();
  });

  it('renders the active panel content', () => {
    renderDialog({ defaultTab: 'alpha' });
    expect(screen.getByTestId('panel-alpha')).toBeInTheDocument();
    // Non-active panels should not render
    expect(screen.queryByTestId('panel-beta')).not.toBeInTheDocument();
  });

  it('switches active tab on sidebar click', () => {
    renderDialog({ defaultTab: 'alpha' });
    expect(screen.getByTestId('panel-alpha')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /beta/i }));
    expect(screen.getByTestId('panel-beta')).toBeInTheDocument();
    expect(screen.queryByTestId('panel-alpha')).not.toBeInTheDocument();
  });

  it('honors initialTab on first open', () => {
    renderDialog({ initialTab: 'gamma', defaultTab: 'alpha' });
    expect(screen.getByTestId('panel-gamma')).toBeInTheDocument();
    expect(screen.queryByTestId('panel-alpha')).not.toBeInTheDocument();
  });

  it('honors initialTab when re-opened with a different value', () => {
    // Start closed with no initialTab
    const { rerender } = renderDialog({ open: false, initialTab: null, defaultTab: 'alpha' });
    // Open with initialTab='beta'
    rerender(
      <TabbedDialog<TabId>
        open={true}
        onOpenChange={vi.fn()}
        title="Test Dialog"
        defaultTab="alpha"
        initialTab="beta"
        tabs={MOCK_TABS}
      />
    );
    expect(screen.getByTestId('panel-beta')).toBeInTheDocument();
    // Close again
    rerender(
      <TabbedDialog<TabId>
        open={false}
        onOpenChange={vi.fn()}
        title="Test Dialog"
        defaultTab="alpha"
        initialTab="beta"
        tabs={MOCK_TABS}
      />
    );
    // Reopen with a different initialTab='gamma'
    rerender(
      <TabbedDialog<TabId>
        open={true}
        onOpenChange={vi.fn()}
        title="Test Dialog"
        defaultTab="alpha"
        initialTab="gamma"
        tabs={MOCK_TABS}
      />
    );
    expect(screen.getByTestId('panel-gamma')).toBeInTheDocument();
  });

  it('falls back to defaultTab when initialTab is null', () => {
    renderDialog({ initialTab: null, defaultTab: 'beta' });
    expect(screen.getByTestId('panel-beta')).toBeInTheDocument();
    expect(screen.queryByTestId('panel-alpha')).not.toBeInTheDocument();
  });

  // A deep link can name a tab that no longer exists — a stale bookmark, a
  // renamed tab, `?settings=bogus`. Selecting it leaves the sidebar with
  // nothing active and the content area empty, which reads as a broken dialog.
  it('falls back to defaultTab when initialTab names a tab that does not exist', () => {
    renderDialog({ initialTab: 'nope' as TabId, defaultTab: 'beta' });

    expect(screen.getByTestId('panel-beta')).toBeInTheDocument();
    // The real symptom of the bug: a dialog with no panel showing at all.
    expect(screen.getByRole('tab', { selected: true })).toHaveTextContent(/beta/i);
  });

  // The fallback above is silent to the user by design (no toast) — but it
  // should not be silent to a developer chasing a stale-link report. DOR-854.
  it('warns in dev when initialTab is unknown, without surfacing anything to the user', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    renderDialog({ initialTab: 'nope' as TabId, defaultTab: 'beta' });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"nope"'));
    // The warning is a console-only signal — nothing renders for the user
    // (no toast, no alert region, no visible error banner).
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    warnSpy.mockRestore();
  });

  it('does not warn when initialTab is a real tab', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    renderDialog({ initialTab: 'gamma', defaultTab: 'alpha' });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('does not warn when initialTab is null (no deep link)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    renderDialog({ initialTab: null, defaultTab: 'beta' });

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  // The warning is gated on import.meta.env.DEV so it never fires in a
  // production build — pinned directly since nothing else in this suite
  // exercises the prod branch (repo pattern: route-error-fallback.test.tsx).
  it('does not warn in a production build even when initialTab is unknown', () => {
    const originalDev = import.meta.env.DEV;
    import.meta.env.DEV = false;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      renderDialog({ initialTab: 'nope' as TabId, defaultTab: 'beta' });
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      import.meta.env.DEV = originalDev;
      warnSpy.mockRestore();
    }
  });

  it('treats an extension-contributed tab as a valid initialTab', () => {
    const ExtensionTab = () => <div data-testid="panel-ext">Extension content</div>;
    mockUseSlotContributions.mockReturnValue([
      {
        id: 'ext1',
        label: 'Extension Tab',
        icon: Settings,
        component: ExtensionTab,
        priority: 100,
      },
    ]);

    // Guards the fallback against over-reaching: extension tabs are not in
    // `tabs`, so a naive check against built-ins only would send them home.
    renderDialog({
      extensionSlot: 'settings.tabs',
      initialTab: 'ext1' as TabId,
      defaultTab: 'alpha',
    });

    expect(screen.getByTestId('panel-ext')).toBeInTheDocument();
    expect(screen.queryByTestId('panel-alpha')).not.toBeInTheDocument();
  });

  it('renders sidebarExtras after the tab list', () => {
    renderDialog({ sidebarExtras: <button>Extra Action</button> });
    const sidebar = screen.getByRole('tablist');
    // sidebarExtras button should be in the DOM
    const extraBtn = screen.getByRole('button', { name: 'Extra Action' });
    expect(extraBtn).toBeInTheDocument();
    // sidebarExtras appears after the tabs in the sidebar — confirmed by sidebar containing it
    expect(sidebar.parentElement).toContainElement(extraBtn);
  });

  it('merges extension contributions when extensionSlot is set', () => {
    const ExtensionTab = () => <div data-testid="panel-ext">Extension content</div>;
    mockUseSlotContributions.mockReturnValue([
      {
        id: 'ext1',
        label: 'Extension Tab',
        icon: Settings,
        component: ExtensionTab,
        priority: 100,
      },
    ]);
    renderDialog({ extensionSlot: 'settings.tabs' });
    // Extension tab label should appear in sidebar
    expect(screen.getByRole('tab', { name: /extension tab/i })).toBeInTheDocument();
  });

  it('does not merge extension contributions when extensionSlot is undefined', () => {
    const ExtensionTab = () => <div data-testid="panel-ext">Extension content</div>;
    mockUseSlotContributions.mockReturnValue([
      {
        id: 'ext1',
        label: 'Extension Tab',
        icon: Settings,
        component: ExtensionTab,
        priority: 100,
      },
    ]);
    // extensionSlot is undefined — contributions must not appear
    renderDialog({ extensionSlot: undefined });
    expect(screen.queryByRole('tab', { name: /extension tab/i })).not.toBeInTheDocument();
  });

  it('renders the title and description', () => {
    renderDialog({ title: 'My Settings', description: 'Manage your preferences' });
    expect(screen.getByText('My Settings')).toBeInTheDocument();
    expect(screen.getByText('Manage your preferences')).toBeInTheDocument();
  });

  it('renders headerSlot under the title', () => {
    renderDialog({ headerSlot: <div data-testid="header-slot">Header Extra</div> });
    expect(screen.getByTestId('header-slot')).toBeInTheDocument();
    expect(screen.getByText('Header Extra')).toBeInTheDocument();
  });

  it('passes maxWidth and minHeight overrides to the dialog', () => {
    const { container } = renderDialog({ maxWidth: 'max-w-4xl', minHeight: 'min-h-[500px]' });
    // maxWidth goes on ResponsiveDialogContent — find it via the child of dialog-root
    const dialogRoot = screen.getByTestId('dialog-root');
    const dialogContentEl = dialogRoot.firstElementChild as HTMLElement;
    expect(dialogContentEl.className).toContain('max-w-4xl');
    // minHeight goes on NavigationLayoutContent — find it via data-slot
    const navContent = container.querySelector(
      '[data-slot="navigation-layout-content"]'
    ) as HTMLElement;
    expect(navContent.className).toContain('min-h-[500px]');
  });

  // ── maximized (DOR-917) ────────────────────────────────────────
  describe('maximized', () => {
    /** The dialog surface itself — where the sizing classes land. */
    function dialogSurface() {
      return screen.getByTestId('dialog-root').firstElementChild as HTMLElement;
    }

    it('takes nearly the whole viewport when maximized, and hugs its content otherwise', () => {
      renderDialog({ maximized: true });

      const surface = dialogSurface();
      expect(surface.className).toContain('md:h-[92svh]');
      expect(surface.className).toContain('md:w-[95vw]');
      expect(surface.className).toContain('md:max-w-[90rem]');
      // Without this the 85vh cap would keep winning and the height would be a lie.
      expect(surface.className).toContain('md:max-h-[92svh]');

      cleanup();
      renderDialog();

      const plain = dialogSurface();
      expect(plain.className).not.toContain('92svh');
      expect(plain.className).toContain('max-w-2xl');
      expect(plain.className).toContain('max-h-[85vh]');
    });

    it('keeps the width override a consumer asked for below the desktop breakpoint', () => {
      renderDialog({ maximized: true, maxWidth: 'max-w-4xl' });

      expect(dialogSurface().className).toContain('max-w-4xl');
    });

    it('leaves the mobile drawer alone: every sizing class it adds is behind `md`', () => {
      // Below 768px `ResponsiveDialogContent` renders a bottom drawer, and a
      // drawer handed `w-[95vw]` stops being a drawer. `md` is that same 768px
      // boundary (`useIsMobile`), so gating there is what keeps the two agreeing.
      renderDialog({ maximized: true });

      const added = dialogSurface()
        .className.split(' ')
        .filter((c) => c.includes('svh') || c.includes('95vw') || c.includes('90rem'));

      expect(added.length).toBeGreaterThan(0);
      expect(added.every((c) => c.startsWith('md:'))).toBe(true);
    });

    it('lets the sidebar and the panel stretch to the height it just claimed', () => {
      // A tall shell with a content-height body is worse than no change at all:
      // the sidebar border stops halfway and the panel floats in empty space.
      const { container } = renderDialog({ maximized: true });

      const layout = container.querySelector('[data-slot="navigation-layout"]') as HTMLElement;
      const body = container.querySelector('[data-slot="navigation-layout-body"]') as HTMLElement;
      const content = container.querySelector(
        '[data-slot="navigation-layout-content"]'
      ) as HTMLElement;

      // Each link in the chain claims the height above it, and clips rather than
      // pushing the shell taller, so the panel is what scrolls.
      expect(layout.className).toContain('flex-1');
      expect(layout.className).toContain('overflow-hidden');
      expect(body.className).toContain('flex-1');
      expect(body.className).toContain('overflow-hidden');
      expect(content.className).toContain('flex-1');
      expect(content.className).toContain('overflow-y-auto');
    });
  });

  it('wraps panels in Suspense for lazy components', async () => {
    const LazyBeta = React.lazy(() =>
      Promise.resolve({ default: () => <div data-testid="panel-lazy-beta">Lazy Beta</div> })
    );

    const lazyTabs: TabbedDialogTab<TabId>[] = [
      { id: 'alpha', label: 'Alpha', icon: Settings, component: TabAlpha },
      { id: 'beta', label: 'Beta', icon: User, component: LazyBeta },
      { id: 'gamma', label: 'Gamma', icon: Bell, component: TabGamma },
    ];

    renderDialog({ tabs: lazyTabs, defaultTab: 'alpha' });

    // Switch to the lazy tab
    fireEvent.click(screen.getByRole('tab', { name: /beta/i }));

    // Wait for the lazy component to resolve
    await waitFor(() => {
      expect(screen.getByTestId('panel-lazy-beta')).toBeInTheDocument();
    });
  });

  it('uses the testId prop for the dialog element', () => {
    renderDialog({ testId: 'my-tabbed-dialog' });
    expect(screen.getByTestId('my-tabbed-dialog')).toBeInTheDocument();
  });

  // ── Grouped sidebar (DOR-858) ──────────────────────────────────
  describe('grouped sidebar', () => {
    it('renders no section headers when no tab declares a group', () => {
      const { container } = renderDialog();
      expect(
        container.querySelectorAll('[data-slot="navigation-layout-section-header"]')
      ).toHaveLength(0);
    });

    it('renders a header per group, ungrouped tabs leading, in first-seen order', () => {
      const groupedTabs: TabbedDialogTab<TabId>[] = [
        { id: 'alpha', label: 'Alpha', icon: Settings, component: TabAlpha },
        { id: 'beta', label: 'Beta', icon: User, component: TabBeta, group: 'Group One' },
        { id: 'gamma', label: 'Gamma', icon: Bell, component: TabGamma, group: 'Group Two' },
      ];
      const { container } = renderDialog({ tabs: groupedTabs });

      const headers = Array.from(
        container.querySelectorAll('[data-slot="navigation-layout-section-header"]')
      ).map((el) => el.textContent);
      expect(headers).toEqual(['Group One', 'Group Two']);

      // A section header is not a tab, so arrow-key navigation walks past it.
      expect(
        container.querySelector('[data-slot="navigation-layout-section-header"]')
      ).toHaveAttribute('role', 'presentation');
    });

    it('files an extension tab with no group under "Add-ons"', () => {
      const ExtensionTab = () => <div data-testid="panel-ext">Extension content</div>;
      mockUseSlotContributions.mockReturnValue([
        { id: 'ext1', label: 'Extension Tab', icon: Settings, component: ExtensionTab },
      ]);
      const groupedTabs: TabbedDialogTab<TabId>[] = [
        { id: 'alpha', label: 'Alpha', icon: Settings, component: TabAlpha },
        { id: 'beta', label: 'Beta', icon: User, component: TabBeta, group: 'Group One' },
      ];
      const { container } = renderDialog({ tabs: groupedTabs, extensionSlot: 'settings.tabs' });

      const headers = Array.from(
        container.querySelectorAll('[data-slot="navigation-layout-section-header"]')
      ).map((el) => el.textContent);
      expect(headers).toEqual(['Group One', 'Add-ons']);
      expect(screen.getByRole('tab', { name: /extension tab/i })).toBeInTheDocument();
    });

    it('respects an explicit group on an extension contribution', () => {
      const ExtensionTab = () => <div data-testid="panel-ext">Extension content</div>;
      mockUseSlotContributions.mockReturnValue([
        {
          id: 'ext1',
          label: 'Extension Tab',
          icon: Settings,
          component: ExtensionTab,
          group: 'Group One',
        },
      ]);
      const groupedTabs: TabbedDialogTab<TabId>[] = [
        { id: 'alpha', label: 'Alpha', icon: Settings, component: TabAlpha },
        { id: 'beta', label: 'Beta', icon: User, component: TabBeta, group: 'Group One' },
      ];
      const { container } = renderDialog({ tabs: groupedTabs, extensionSlot: 'settings.tabs' });

      const headers = Array.from(
        container.querySelectorAll('[data-slot="navigation-layout-section-header"]')
      ).map((el) => el.textContent);
      // Only one "Group One" header — the extension tab joined the existing group.
      expect(headers).toEqual(['Group One']);
    });
  });
});
