/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { Settings, User, Bell } from 'lucide-react';
import { TabbedDialog, type TabbedDialogFoldedGroup, type TabbedDialogTab } from '../tabbed-dialog';
import type { SettingsTabContribution } from '@/layers/shared/model';

// --------------------------------------------------------------------------- Mock: useIsMobile +
// useSlotContributions
// ---------------------------------------------------------------------------

const mockUseSlotContributions = vi.fn<() => SettingsTabContribution[]>(() => []);
const viewport = vi.hoisted(() => ({ mobile: false }));

vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useIsMobile: () => viewport.mobile,
  useSlotContributions: () => mockUseSlotContributions(),
}));

// --------------------------------------------------------------------------- Mock: dialog +
// drawer (required by ResponsiveDialog → ResponsiveDialogContent)
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

// --------------------------------------------------------------------------- matchMedia shim
// (required by jsdom) ---------------------------------------------------------------------------

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
  viewport.mobile = false;
  localStorage.clear();
});

// --------------------------------------------------------------------------- Fixtures
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
  extensionSlot?: 'settings.tabs';
  maxWidth?: string;
  minHeight?: string;
  maximized?: boolean;
  testId?: string;
  tabs?: TabbedDialogTab<TabId>[];
  headerSlot?: React.ReactNode;
  description?: string;
  title?: React.ReactNode;
  foldedGroup?: TabbedDialogFoldedGroup;
}

function renderDialog(options: RenderOptions = {}) {
  const {
    open = true,
    initialTab,
    defaultTab = 'alpha',
    extensionSlot,
    maxWidth,
    minHeight,
    maximized,
    testId,
    tabs = MOCK_TABS,
    headerSlot,
    description,
    title = 'Test Dialog',
    foldedGroup,
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
      extensionSlot={extensionSlot}
      maxWidth={maxWidth}
      minHeight={minHeight}
      maximized={maximized}
      foldedGroup={foldedGroup}
      testId={testId}
    />
  );

  return { ...result, onOpenChange };
}

// --------------------------------------------------------------------------- Tests
// ---------------------------------------------------------------------------

describe('TabbedDialog', () => {
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

  // A deep link can name a tab that no longer exists — a stale bookmark, a renamed tab,
  // `?settings=bogus`.
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

  // ── Grouped sidebar (DOR-858) ──────────────────────────────────
  describe('grouped sidebar', () => {
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
  });

  // ── Folded group (DOR-2629) ────────────────────────────────────
  describe('folded group', () => {
    const FOLD: TabbedDialogFoldedGroup = { group: 'Later', storageKey: 'test-fold-open' };
    const FOLD_TABS: TabbedDialogTab<TabId>[] = [
      // Declared FIRST on purpose: a folded group renders last regardless.
      { id: 'gamma', label: 'Gamma', icon: Bell, component: TabGamma, group: 'Later' },
      { id: 'alpha', label: 'Alpha', icon: Settings, component: TabAlpha, group: 'Now' },
      { id: 'beta', label: 'Beta', icon: User, component: TabBeta, group: 'Now' },
    ];
    const toggle = () => screen.getByRole('button', { name: 'Later' });
    const labels = () => screen.getAllByRole('tab').map((t) => t.textContent);

    it('starts folded, with no list rendered and nothing named in aria-controls', () => {
      renderDialog({ tabs: FOLD_TABS, foldedGroup: FOLD });
      expect(toggle()).toHaveAttribute('aria-expanded', 'false');
      expect(labels()).toEqual(['Alpha', 'Beta']);
      expect(screen.getAllByRole('tablist')).toHaveLength(1);
      expect(toggle()).not.toHaveAttribute('aria-controls');
    });

    it('walks the arrow keys across both lists as one sequence', () => {
      renderDialog({ tabs: FOLD_TABS, foldedGroup: FOLD, initialTab: 'beta' });
      fireEvent.click(toggle());
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Beta' }), { key: 'ArrowDown' });
      expect(screen.getByRole('tab', { name: 'Gamma' })).toHaveAttribute('aria-selected', 'true');
      fireEvent.keyDown(screen.getByRole('tab', { name: 'Gamma' }), { key: 'ArrowDown' });
      expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'true');
    });

    it('unfolds itself when the dialog opens on one of its tabs', () => {
      renderDialog({ tabs: FOLD_TABS, foldedGroup: FOLD, initialTab: 'gamma' });
      expect(toggle()).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('tab', { name: 'Gamma' })).toHaveAttribute('aria-selected', 'true');
      // A reveal is not a remembered choice.
      expect(localStorage.getItem('test-fold-open')).toBeNull();
    });
  });
});
