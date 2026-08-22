import { SystemHealthDot, useSystemHealth } from '@/layers/features/top-nav';
import { BarTitle, OneBar } from './OneBar';

/**
 * Home route bar — title and health dot. Starting a conversation lives in the
 * page's composer, not here.
 *
 * The title says **Home**, matching the tab that opens this page. Two words for
 * one place is one word too many, and the home surface's tab strip reads "Home"
 * — a bar reading "Dashboard" over it made the same screen disagree with itself.
 */
export function DashboardHeader() {
  const healthState = useSystemHealth();

  return (
    <OneBar identity={<BarTitle>Home</BarTitle>} chips={<SystemHealthDot state={healthState} />} />
  );
}
