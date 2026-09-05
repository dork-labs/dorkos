import { MessageSquare, Bell, Zap } from 'lucide-react';
import { useOpenConnections } from '@/layers/shared/model';
import type { PromoDialogProps } from '../../model/promo-types';
import { PromoDialogLayout } from './PromoDialogLayout';

/** Dialog content for the Relay Adapters promo. */
export function RelayAdaptersDialog({ onClose }: PromoDialogProps) {
  const openConnections = useOpenConnections();

  const handleSetUp = () => {
    onClose();
    openConnections('messaging');
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
          title: 'Real-time notifications',
          description: 'Know when agents finish, fail, or need input',
        },
        {
          icon: Zap,
          title: 'Two-way communication',
          description: 'Reply to agents directly from your messaging app',
        },
      ]}
      primaryAction={{ label: 'Connect Telegram & Slack', onClick: handleSetUp }}
      secondaryAction={{ label: 'Not now', onClick: onClose }}
    />
  );
}
