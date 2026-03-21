import { useNavigate } from '@tanstack/react-router';
import { Plus, Clock } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { useAppStore } from '@/layers/shared/model';
import { usePulseEnabled } from '@/layers/entities/pulse';
import { CommandPaletteTrigger } from './CommandPaletteTrigger';
import { SystemHealthDot } from './SystemHealthDot';
import { useSystemHealth } from '../model/use-system-health';

/** Dashboard route header — title, health dot, quick actions, and command palette trigger. */
export function DashboardHeader() {
  const navigate = useNavigate();
  const healthState = useSystemHealth();
  const pulseEnabled = usePulseEnabled();
  const setPulseOpen = useAppStore((s) => s.setPulseOpen);

  return (
    <>
      <span className="text-muted-foreground text-sm font-medium">Dashboard</span>
      <SystemHealthDot state={healthState} />
      <div className="flex-1" />
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 text-xs"
          onClick={() => navigate({ to: '/session' })}
        >
          <Plus className="size-3" />
          New session
        </Button>
        {pulseEnabled && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs"
            onClick={() => setPulseOpen(true)}
          >
            <Clock className="size-3" />
            Schedule
          </Button>
        )}
      </div>
      <CommandPaletteTrigger />
    </>
  );
}
