// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import {
  NavigationLayout,
  NavigationLayoutSidebar,
  NavigationLayoutItem,
  NavigationLayoutContent,
  NavigationLayoutPanel,
  useNavigationLayout,
} from '../navigation-layout';

// Mock useIsMobile to control desktop/mobile rendering
const mockUseIsMobile = vi.fn(() => false);
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useIsMobile: () => mockUseIsMobile(),
}));

// Mock motion components to render plain DOM elements
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
          layoutId: _l,
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
          layoutId: _l,
          autoFocus,
          ...props
        }: Record<string, unknown> & { children?: React.ReactNode; autoFocus?: boolean },
        ref: React.Ref<HTMLButtonElement>
      ) => <button ref={ref} autoFocus={autoFocus} {...props} />
    ),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  LayoutGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  mockUseIsMobile.mockReturnValue(false);
});

function renderDesktopNav(activeValue = 'one', onValueChange = vi.fn()) {
  return render(
    <NavigationLayout value={activeValue} onValueChange={onValueChange}>
      <NavigationLayoutSidebar>
        <NavigationLayoutItem value="one">One</NavigationLayoutItem>
        <NavigationLayoutItem value="two">Two</NavigationLayoutItem>
        <NavigationLayoutItem value="three">Three</NavigationLayoutItem>
      </NavigationLayoutSidebar>
      <NavigationLayoutContent>
        <NavigationLayoutPanel value="one">Panel One</NavigationLayoutPanel>
        <NavigationLayoutPanel value="two">Panel Two</NavigationLayoutPanel>
        <NavigationLayoutPanel value="three">Panel Three</NavigationLayoutPanel>
      </NavigationLayoutContent>
    </NavigationLayout>
  );
}

describe('NavigationLayout — desktop', () => {
  it('renders sidebar and content side by side', () => {
    renderDesktopNav();
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.getByText('Panel One')).toBeInTheDocument();
  });

  it('renders active item with aria-selected="true"', () => {
    renderDesktopNav('two');
    const activeTab = screen.getByRole('tab', { name: 'Two' });
    expect(activeTab).toHaveAttribute('aria-selected', 'true');
  });

  it('renders inactive items with aria-selected="false"', () => {
    renderDesktopNav('one');
    const inactiveTab = screen.getByRole('tab', { name: 'Two' });
    expect(inactiveTab).toHaveAttribute('aria-selected', 'false');
  });

  it('only renders the active panel', () => {
    renderDesktopNav('one');
    expect(screen.getByText('Panel One')).toBeInTheDocument();
    expect(screen.queryByText('Panel Two')).not.toBeInTheDocument();
  });

  it('calls onValueChange when clicking an item', () => {
    const onChange = vi.fn();
    renderDesktopNav('one', onChange);
    fireEvent.click(screen.getByRole('tab', { name: 'Two' }));
    expect(onChange).toHaveBeenCalledWith('two');
  });

  it('renders active panel as tabpanel with aria-labelledby', () => {
    renderDesktopNav('one');
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAttribute('aria-labelledby', 'nav-item-one');
  });
});

describe('NavigationLayout — keyboard navigation', () => {
  it('ArrowDown moves to next item', () => {
    const onChange = vi.fn();
    renderDesktopNav('one', onChange);
    const tab = screen.getByRole('tab', { name: 'One' });
    fireEvent.keyDown(tab.closest('[role="tablist"]')!.parentElement!, {
      key: 'ArrowDown',
    });
    expect(onChange).toHaveBeenCalledWith('two');
  });

  it('ArrowUp moves to previous item', () => {
    const onChange = vi.fn();
    renderDesktopNav('two', onChange);
    const tablist = screen.getByRole('tablist').parentElement!;
    fireEvent.keyDown(tablist, { key: 'ArrowUp' });
    expect(onChange).toHaveBeenCalledWith('one');
  });

  it('Home jumps to first item', () => {
    const onChange = vi.fn();
    renderDesktopNav('three', onChange);
    const tablist = screen.getByRole('tablist').parentElement!;
    fireEvent.keyDown(tablist, { key: 'Home' });
    expect(onChange).toHaveBeenCalledWith('one');
  });

  it('End jumps to last item', () => {
    const onChange = vi.fn();
    renderDesktopNav('one', onChange);
    const tablist = screen.getByRole('tablist').parentElement!;
    fireEvent.keyDown(tablist, { key: 'End' });
    expect(onChange).toHaveBeenCalledWith('three');
  });

  it('ArrowDown wraps from last to first', () => {
    const onChange = vi.fn();
    renderDesktopNav('three', onChange);
    const tablist = screen.getByRole('tablist').parentElement!;
    fireEvent.keyDown(tablist, { key: 'ArrowDown' });
    expect(onChange).toHaveBeenCalledWith('one');
  });
});

describe('NavigationLayout — mobile', () => {
  beforeEach(() => {
    mockUseIsMobile.mockReturnValue(true);
  });

  it('renders list view initially', () => {
    renderDesktopNav();
    expect(screen.getByRole('list')).toBeInTheDocument();
    // All items should be buttons in list
    expect(screen.getByRole('button', { name: /One/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Two/i })).toBeInTheDocument();
  });

  it('does not render panels until drilled in', () => {
    renderDesktopNav();
    expect(screen.queryByText('Panel One')).not.toBeInTheDocument();
  });

  it('drills into content on item click', () => {
    const onChange = vi.fn();
    render(
      <MobileNavWrapper initialValue="one" onValueChange={onChange}>
        <NavigationLayoutSidebar>
          <NavigationLayoutItem value="one">One</NavigationLayoutItem>
          <NavigationLayoutItem value="two">Two</NavigationLayoutItem>
        </NavigationLayoutSidebar>
        <NavigationLayoutContent>
          <NavigationLayoutPanel value="one">Panel One</NavigationLayoutPanel>
          <NavigationLayoutPanel value="two">Panel Two</NavigationLayoutPanel>
        </NavigationLayoutContent>
      </MobileNavWrapper>
    );

    fireEvent.click(screen.getByRole('button', { name: /Two/i }));
    expect(screen.getByText('Panel Two')).toBeInTheDocument();
    // List should be hidden
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('shows back button when drilled in', () => {
    render(
      <MobileNavWrapper initialValue="one">
        <NavigationLayoutSidebar>
          <NavigationLayoutItem value="one">First</NavigationLayoutItem>
        </NavigationLayoutSidebar>
        <NavigationLayoutContent>
          <NavigationLayoutPanel value="one">Panel One</NavigationLayoutPanel>
        </NavigationLayoutContent>
      </MobileNavWrapper>
    );

    fireEvent.click(screen.getByRole('button', { name: /First/i }));
    // Back button shows active label
    expect(screen.getByText('First')).toBeInTheDocument();
  });

  it('returns to list when back is clicked', () => {
    render(
      <MobileNavWrapper initialValue="one">
        <NavigationLayoutSidebar>
          <NavigationLayoutItem value="one">First</NavigationLayoutItem>
        </NavigationLayoutSidebar>
        <NavigationLayoutContent>
          <NavigationLayoutPanel value="one">Panel One</NavigationLayoutPanel>
        </NavigationLayoutContent>
      </MobileNavWrapper>
    );

    // Drill in
    fireEvent.click(screen.getByRole('button', { name: /First/i }));
    expect(screen.getByText('Panel One')).toBeInTheDocument();

    // Go back — the back button contains "First" text + ChevronLeft icon
    const backBtn = screen.getByText('First').closest('button')!;
    fireEvent.click(backBtn);

    // List should reappear
    expect(screen.getByRole('list')).toBeInTheDocument();
  });
});

describe('useNavigationLayout', () => {
  it('throws when used outside provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function TestComponent() {
      useNavigationLayout();
      return null;
    }

    expect(() => render(<TestComponent />)).toThrow(
      'useNavigationLayout must be used within a <NavigationLayout>'
    );
    spy.mockRestore();
  });
});

describe('className merging', () => {
  it('merges custom className on NavigationLayout', () => {
    const { container } = renderDesktopNav();
    const root = container.querySelector('[data-slot="navigation-layout"]')!;
    expect(root.className).toContain('flex');
  });

  it('merges custom className on NavigationLayoutSidebar', () => {
    render(
      <NavigationLayout value="one" onValueChange={vi.fn()}>
        <NavigationLayoutSidebar className="custom-sidebar">
          <NavigationLayoutItem value="one">One</NavigationLayoutItem>
        </NavigationLayoutSidebar>
        <NavigationLayoutContent>
          <NavigationLayoutPanel value="one">Panel</NavigationLayoutPanel>
        </NavigationLayoutContent>
      </NavigationLayout>
    );
    const sidebar = screen.getByRole('tablist');
    expect(sidebar.className).toContain('custom-sidebar');
  });

  it('merges custom className on NavigationLayoutPanel', () => {
    render(
      <NavigationLayout value="one" onValueChange={vi.fn()}>
        <NavigationLayoutSidebar>
          <NavigationLayoutItem value="one">One</NavigationLayoutItem>
        </NavigationLayoutSidebar>
        <NavigationLayoutContent>
          <NavigationLayoutPanel value="one" className="custom-panel">
            Panel
          </NavigationLayoutPanel>
        </NavigationLayoutContent>
      </NavigationLayout>
    );
    const panel = screen.getByRole('tabpanel');
    expect(panel.className).toContain('custom-panel');
  });
});

describe('displayNames', () => {
  it.each([
    ['NavigationLayout', NavigationLayout],
    ['NavigationLayoutSidebar', NavigationLayoutSidebar],
    ['NavigationLayoutItem', NavigationLayoutItem],
    ['NavigationLayoutContent', NavigationLayoutContent],
    ['NavigationLayoutPanel', NavigationLayoutPanel],
  ])('%s has displayName set', (name, component) => {
    expect(component.displayName).toBe(name);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wrapper that manages its own state for testing mobile drill-in/out. */
function MobileNavWrapper({
  children,
  initialValue,
  onValueChange: externalOnChange,
}: {
  children: React.ReactNode;
  initialValue: string;
  onValueChange?: (v: string) => void;
}) {
  const [value, setValue] = React.useState(initialValue);
  const handleChange = (v: string) => {
    setValue(v);
    externalOnChange?.(v);
  };
  return (
    <NavigationLayout value={value} onValueChange={handleChange}>
      {children}
    </NavigationLayout>
  );
}
