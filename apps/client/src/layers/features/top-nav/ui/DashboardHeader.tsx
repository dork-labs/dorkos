import { MessageSquarePlus } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { useDefaultAgentSession } from '@/layers/entities/config';
import { SystemHealthDot } from './SystemHealthDot';
import { useSystemHealth } from '../model/use-system-health';
import { PageHeader } from './PageHeader';

/** Dashboard route header — title, health dot, start-a-conversation action, and command palette trigger. */
export function DashboardHeader() {
  const healthState = useSystemHealth();
  const { startSession } = useDefaultAgentSession();

  return (
    <PageHeader
      title="Dashboard"
      actions={
        <Button size="sm" onClick={startSession}>
          <MessageSquarePlus className="size-4" />
          New conversation
        </Button>
      }
    >
      <SystemHealthDot state={healthState} />
    </PageHeader>
  );
}
