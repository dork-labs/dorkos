import { MessageSquare, Bell, Zap } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { useRelayDeepLink } from '@/layers/shared/model';
import type { PromoDialogProps } from '../../model/promo-types';

/** Dialog content for the Relay Adapters promo. */
export function RelayAdaptersDialog({ onClose }: PromoDialogProps) {
  const { open: openRelay } = useRelayDeepLink();

  const handleSetUp = () => {
    onClose();
    openRelay();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-gradient-to-br from-purple-500/10 to-purple-600/10">
          <MessageSquare className="size-5 text-purple-500" />
        </div>
        <div>
          <h3 className="text-sm font-medium">Get notified where you already are</h3>
          <p className="text-muted-foreground text-xs">Slack, Telegram, and more</p>
        </div>
      </div>

      <div className="bg-muted/50 space-y-3 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <Bell className="text-muted-foreground mt-0.5 size-4" />
          <div>
            <p className="text-xs font-medium">Real-time notifications</p>
            <p className="text-muted-foreground text-xs">
              Know when agents finish, fail, or need input
            </p>
          </div>
        </div>
        <div className="flex items-start gap-3">
          <Zap className="text-muted-foreground mt-0.5 size-4" />
          <div>
            <p className="text-xs font-medium">Two-way communication</p>
            <p className="text-muted-foreground text-xs">
              Reply to agents directly from your messaging app
            </p>
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Not now
        </Button>
        <Button size="sm" onClick={handleSetUp}>
          Set up adapters
        </Button>
      </div>
    </div>
  );
}
