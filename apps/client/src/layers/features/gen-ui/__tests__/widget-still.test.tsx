/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { useWidgetMotion, WidgetStillProvider } from '../lib/widget-motion';
import { WidgetNodeView } from '../ui/WidgetNodeView';

const still = ({ children }: { children: ReactNode }) => (
  <WidgetStillProvider value>{children}</WidgetStillProvider>
);

describe('WidgetStillProvider', () => {
  it('turns widget motion off under it, and only under it', () => {
    expect(renderHook(() => useWidgetMotion()).result.current).toBe(true);
    expect(renderHook(() => useWidgetMotion(), { wrapper: still }).result.current).toBe(false);
  });

  it('renders a counted value at its final number on the first render', () => {
    const stat = <WidgetNodeView node={{ type: 'stat', label: 'Signups', value: 1204 }} />;
    // The first frame of a count-up is 0; a server render would freeze it there.
    expect(renderToStaticMarkup(stat)).not.toContain('1204');
    expect(renderToStaticMarkup(still({ children: stat }))).toContain('>1204<');
  });
});
