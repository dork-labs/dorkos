import { SystemHealthDot } from './SystemHealthDot';
import { useSystemHealth } from '../model/use-system-health';
import { PageHeader } from './PageHeader';

/**
 * Home route header — title, health dot, and command palette trigger.
 * Starting a conversation lives in the page's composer, not here.
 *
 * The title says **Home**, matching the tab that opens this page. Two words for
 * one place is one word too many, and the tab bar sits directly below this
 * header — a header reading "Dashboard" over a tab reading "Home" made the same
 * screen disagree with itself.
 */
export function DashboardHeader() {
  const healthState = useSystemHealth();

  return (
    <PageHeader title="Home">
      <SystemHealthDot state={healthState} />
    </PageHeader>
  );
}
