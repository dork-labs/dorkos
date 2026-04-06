/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import * as React from 'react';
import { NavigationLayout } from '../navigation-layout';
import { SettingsPanel } from '../settings-panel';

// Mock useIsMobile so NavigationLayout renders in desktop mode
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useIsMobile: () => false,
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
        // eslint-disable-next-line jsx-a11y/no-autofocus -- Test mock passes through autoFocus to mirror production component
      ) => <button ref={ref} autoFocus={autoFocus} {...props} />
    ),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  LayoutGroup: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

afterEach(cleanup);

describe('SettingsPanel', () => {
  it('renders title in the panel header', () => {
    render(
      <NavigationLayout value="foo" onValueChange={vi.fn()}>
        <SettingsPanel value="foo" title="My Title">
          <div data-testid="child">child</div>
        </SettingsPanel>
      </NavigationLayout>
    );
    expect(screen.getByText('My Title')).toBeInTheDocument();
  });

  it('renders actions slot when provided', () => {
    render(
      <NavigationLayout value="foo" onValueChange={vi.fn()}>
        <SettingsPanel value="foo" title="My Title" actions={<button>Reset</button>}>
          <div data-testid="child">child</div>
        </SettingsPanel>
      </NavigationLayout>
    );
    expect(screen.getByRole('button', { name: 'Reset' })).toBeInTheDocument();
  });

  it('renders children inside a space-y-4 wrapper', () => {
    render(
      <NavigationLayout value="foo" onValueChange={vi.fn()}>
        <SettingsPanel value="foo" title="My Title">
          <div data-testid="child">child</div>
        </SettingsPanel>
      </NavigationLayout>
    );
    const child = screen.getByTestId('child');
    // The space-y-4 wrapper is the direct parent of the header and children
    expect(child.parentElement).toHaveClass('space-y-4');
  });

  it('renders nothing when value does not match the parent NavigationLayout active tab', () => {
    render(
      <NavigationLayout value="bar" onValueChange={vi.fn()}>
        <SettingsPanel value="foo" title="My Title">
          <div data-testid="child">child</div>
        </SettingsPanel>
      </NavigationLayout>
    );
    expect(screen.queryByText('My Title')).toBeNull();
  });
});
