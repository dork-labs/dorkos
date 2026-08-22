import type { ReactNode } from 'react';
import { TooltipProvider } from '@/layers/shared/ui';
import { OneBarProvider, type OneBarRouteState } from '../model/one-bar-context';

/** A bar state with nothing open — each suite overrides only what it asserts on. */
export const emptyBarState: OneBarRouteState = {
  agentName: undefined,
  agentVisual: undefined,
  origin: undefined,
  originLabel: undefined,
  sessionTitle: undefined,
  sessionDirectoryName: undefined,
  roomTitle: null,
  teamViewMode: 'cards',
};

/**
 * Wraps a route bar in what the shell gives it: the tooltip provider the fixed
 * cluster needs, and the resolved route state it reads.
 *
 * @param props - Overrides for the bar state, and the bar itself.
 */
export function BarHarness({
  children,
  ...overrides
}: Partial<OneBarRouteState> & { children: ReactNode }) {
  return (
    <TooltipProvider>
      <OneBarProvider value={{ ...emptyBarState, ...overrides }}>{children}</OneBarProvider>
    </TooltipProvider>
  );
}
