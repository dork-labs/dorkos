import { SystemHealthDot } from './SystemHealthDot';
import { useSystemHealth } from '../model/use-system-health';
import { PageHeader } from './PageHeader';

/** Dashboard route header — title, health dot, and command palette trigger. */
export function DashboardHeader() {
  const healthState = useSystemHealth();

  return (
    <PageHeader title="Dashboard">
      <SystemHealthDot state={healthState} />
    </PageHeader>
  );
}
