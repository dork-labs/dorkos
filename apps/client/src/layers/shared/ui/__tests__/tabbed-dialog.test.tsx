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
// Mock: motion/react (strip animation props, render plain DOM elements)
// ---------------------------------------------------------------------------

vi.mock('motion/react', () => ({
  motion: {
    div: React.forwardRef(
      (
        {
          initial: _i,
          animate: _a,
          exit: _e,
          transition: _t,
          whileTap: _w,
          layoutId: _li,
          layout: _lo,
          ...props
        }: Record<string, unknown> & { children?: React.ReactNode },
        ref: React.Ref<HTMLDivElement>
      ) => <div ref={ref} {...props} />
    ),
    button: React.forwardRef(
      (
        {
          initial: _i,
          animate: _a,
          exit: _e,
          transition: _t,
          whileTap: _w,
          layoutId: _li,
          layout: _lo,
          autoFocus,
          ...props
        }: Record<string, unknown> & { children?: React.ReactNode; autoFocus?: boolean },
        ref: React.Ref<HTMLButtonElement>
        // eslint-disable-next-line jsx-a11y/no-autofocus -- Test mock mirrors production autoFocus behavior
      ) => <button ref={ref} autoFocus={autoFocus} {...props} />
    ),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  LayoutGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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
});
