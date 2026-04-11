import { MessagesSquare, Users, Network } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { useNavigate } from '@tanstack/react-router';
import type { PromoDialogProps } from '../../model/promo-types';

/** Dialog content for the Agent-to-Agent Chat promo. */
export function AgentChatDialog({ onClose }: PromoDialogProps) {
  const navigate = useNavigate();

  const handleExplore = () => {
    onClose();
    navigate({ to: '/agents' });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-500/10 to-emerald-600/10">
          <MessagesSquare className="size-5 text-emerald-500" />
        </div>
        <div>
          <h3 className="text-sm font-medium">Let your agents collaborate</h3>
          <p className="text-muted-foreground text-xs">Agent-to-agent communication via Mesh</p>
        </div>
      </div>

      <div className="bg-muted/50 space-y-3 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <Users className="text-muted-foreground mt-0.5 size-4" />
          <div>
            <p className="text-xs font-medium">Multi-agent workflows</p>
            <p className="text-muted-foreground text-xs">
              Agents can delegate tasks and share context
            </p>
          </div>
        </div>
        <div className="flex items-start gap-3">
          <Network className="text-muted-foreground mt-0.5 size-4" />
          <div>
            <p className="text-xs font-medium">Topology view</p>
            <p className="text-muted-foreground text-xs">
              Visualize how your agents connect and communicate
            </p>
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Not now
        </Button>
        <Button size="sm" onClick={handleExplore}>
          Explore Mesh
        </Button>
      </div>
    </div>
  );
}
