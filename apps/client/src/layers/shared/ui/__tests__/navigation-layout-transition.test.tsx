// @vitest-environment jsdom
//
// The rest of the NavigationLayout suite runs against the global `motion/react`
// mock from `src/test-setup.ts`, where `AnimatePresence` is a pass-through. That
// mock is the right default — it keeps component tests about markup rather than
// about frames — but it cannot see the defect this file exists for, because the
// defect IS an exiting element that the pass-through never keeps around.
//
// So this file, and only this file, runs the real animation library.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';

vi.unmock('motion/react');

// Desktop is the branch that renders `role="tabpanel"` and the `nav-panel-*`
// ids; the mobile drill-in renders neither.
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useIsMobile: () => false,
}));

import {
  NavigationLayout,
  NavigationLayoutSidebar,
  NavigationLayoutItem,
  NavigationLayoutContent,
  NavigationLayoutPanel,
} from '../navigation-layout';

afterEach(() => {
  cleanup();
});

/** Every DOM id inside `root` that more than one element claims. */
function duplicateIds(root: ParentNode): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const el of root.querySelectorAll('[id]')) {
    if (seen.has(el.id)) duplicates.add(el.id);
    seen.add(el.id);
  }
  return [...duplicates];
}

function Nav({ value, onValueChange }: { value: string; onValueChange?: (v: string) => void }) {
  return (
    <NavigationLayout value={value} onValueChange={onValueChange ?? vi.fn()}>
      <NavigationLayoutSidebar>
        <NavigationLayoutItem value="one">One</NavigationLayoutItem>
        <NavigationLayoutItem value="two">Two</NavigationLayoutItem>
      </NavigationLayoutSidebar>
      <NavigationLayoutContent>
        <NavigationLayoutPanel value="one">Panel One</NavigationLayoutPanel>
        <NavigationLayoutPanel value="two">Panel Two</NavigationLayoutPanel>
      </NavigationLayoutContent>
    </NavigationLayout>
  );
}

/** Controlled wrapper, so a click drives the switch the way the dialog does. */
function StatefulNav() {
  const [value, setValue] = React.useState('one');
  return <Nav value={value} onValueChange={setValue} />;
}

describe('NavigationLayout — tab switch exposes exactly one panel', () => {
  // Sampled synchronously after the commit: this is the instant the old
  // `AnimatePresence mode="popLayout"` crossfade held two panels, both of them
  // carrying the incoming tab's id.
  it('renders one tabpanel and no duplicate ids the moment the value changes', () => {
    const { rerender, container } = render(<Nav value="one" />);
    expect(container.querySelectorAll('[role="tabpanel"]')).toHaveLength(1);

    rerender(<Nav value="two" />);

    expect(duplicateIds(container)).toEqual([]);
    const panels = container.querySelectorAll('[role="tabpanel"]');
    expect(panels).toHaveLength(1);
    // Matched against the tab rather than a literal id: ids are scoped per
    // layout now, so the pair is the thing worth asserting.
    const selected = screen.getByRole('tab', { selected: true });
    expect(selected).toHaveAccessibleName('Two');
    expect(panels[0]).toHaveAttribute('id', selected.getAttribute('aria-controls'));
    expect(panels[0]).toHaveAttribute('aria-labelledby', selected.id);
  });

  it('keeps the selected tab pointing at a panel that exists exactly once', () => {
    const { container } = render(<StatefulNav />);

    fireEvent.click(screen.getByRole('tab', { name: 'Two' }));

    const selected = screen.getByRole('tab', { selected: true });
    expect(selected).toHaveAccessibleName('Two');
    const controls = selected.getAttribute('aria-controls')!;
    expect(container.querySelectorAll(`#${CSS.escape(controls)}`)).toHaveLength(1);
    expect(duplicateIds(container)).toEqual([]);
  });

  it('shows only the incoming panel, never both', () => {
    const { rerender } = render(<Nav value="one" />);
    rerender(<Nav value="two" />);

    expect(screen.getByText('Panel Two')).toBeInTheDocument();
    expect(screen.queryByText('Panel One')).not.toBeInTheDocument();
  });
});
