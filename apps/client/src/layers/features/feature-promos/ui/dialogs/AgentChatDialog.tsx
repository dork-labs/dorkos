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
      title="Let your agents work together"
      subtitle="Agents can message each other"
      highlights={[
        {
          icon: Users,
          title: 'Shared work',
          description: 'Agents hand tasks to each other',
        },
        {
          icon: Network,
          title: 'Topology view',
          description: 'See which agents talk to each other',
        },
      ]}
      primaryAction={{ label: 'Open Team', onClick: handleExplore }}
      secondaryAction={{ label: 'Not now', onClick: onClose }}
    />
  );
}
