import { MessagesSquare, Users, Network } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import type { PromoDialogProps } from '../../model/promo-types';
import { PromoDialogLayout } from './PromoDialogLayout';

/** Dialog content for the Agent-to-Agent Chat promo. */
export function AgentChatDialog({ onClose }: PromoDialogProps) {
  const navigate = useNavigate();

  const handleExplore = () => {
    onClose();
    navigate({ to: '/team' });
  };

  return (
    <PromoDialogLayout
      icon={MessagesSquare}
      tint="emerald"
      title="Let your agents collaborate"
      subtitle="Agent-to-agent communication via Mesh"
      highlights={[
        {
          icon: Users,
          title: 'Multi-agent workflows',
          description: 'Agents can delegate tasks and share context',
        },
        {
          icon: Network,
          title: 'Topology view',
          description: 'Visualize how your agents connect and communicate',
        },
      ]}
      primaryAction={{ label: 'Explore Mesh', onClick: handleExplore }}
      secondaryAction={{ label: 'Not now', onClick: onClose }}
    />
  );
}
