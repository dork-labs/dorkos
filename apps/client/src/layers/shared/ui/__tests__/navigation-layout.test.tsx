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

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  mockUseIsMobile.mockReturnValue(false);
});

/** One desktop nav, rendered as many times as a test needs. */
function desktopNav(activeValue = 'one', onValueChange = vi.fn()) {
  return (
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

function renderDesktopNav(activeValue = 'one', onValueChange = vi.fn()) {
  return render(desktopNav(activeValue, onValueChange));
}

describe('NavigationLayout — desktop', () => {
  it('renders sidebar and content side by side', () => {
    renderDesktopNav();
    expect(screen.getByRole('tablist')).toBeInTheDocument();
    expect(screen.getByText('Panel One')).toBeInTheDocument();
  });

  // The relationship, not the literal id: ids are scoped per layout now, so two settings dialogs
  // on one screen cannot both mint `nav-item-one` and leave an `aria-controls` naming two
  // elements.
  it('points the active panel at the tab that selected it, both ways', () => {
    renderDesktopNav('one');
    const panel = screen.getByRole('tabpanel');
    const tab = screen.getByRole('tab', { name: 'One' });
    expect(panel).toHaveAttribute('aria-labelledby', tab.id);
    expect(tab).toHaveAttribute('aria-controls', panel.id);
  });
});

describe('NavigationLayout — keyboard navigation', () => {
  it('ArrowDown moves to next item', () => {
    const onChange = vi.fn();
    renderDesktopNav('one', onChange);
    // Pressed on the focused TAB, which is where a real key lands; it bubbles to the tablist that
    // handles it.
    fireEvent.keyDown(screen.getByRole('tab', { name: 'One' }), { key: 'ArrowDown' });
    expect(onChange).toHaveBeenCalledWith('two');
  });

  it('Home jumps to first item', () => {
    const onChange = vi.fn();
    renderDesktopNav('three', onChange);
    const tablist = screen.getByRole('tablist');
    fireEvent.keyDown(tablist, { key: 'Home' });
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

// --------------------------------------------------------------------------- Helpers
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
