import { MessageSquare, Bell, Zap } from 'lucide-react';
import { useOpenConnections } from '@/layers/shared/model';
import type { PromoDialogProps } from '../../model/promo-types';
import { PromoDialogLayout } from './PromoDialogLayout';

/** Dialog content for the Relay Adapters promo. */
export function RelayAdaptersDialog({ onClose }: PromoDialogProps) {
  const openConnections = useOpenConnections();

  const handleSetUp = () => {
    onClose();
    openConnections();
  };

  return (
    <PromoDialogLayout
      icon={MessageSquare}
      tint="purple"
      title="Get notified where you already are"
      subtitle="Slack, Telegram, and more"
      highlights={[
        {
          icon: Bell,
          title: 'Notifications',
          description: 'Hear when agents finish or need you',
        },
        {
          icon: Zap,
          title: 'Reply from chat',
          description: 'Answer agents from Telegram or Slack',
        },
      ]}
      primaryAction={{ label: 'Connect Telegram & Slack', onClick: handleSetUp }}
      secondaryAction={{ label: 'Not now', onClick: onClose }}
    />
  );
}
