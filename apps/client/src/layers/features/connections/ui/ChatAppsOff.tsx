/**
 * What Connections shows while chat apps (Telegram, Slack, webhooks) aren't
 * running, with the one step that gets them running from the app itself.
 *
 * Chat apps run on the same message system agents use to reach each other,
 * which DorkOS starts once, when it starts. So turning them on is two honest
 * steps: save the setting (Settings › Advanced › Tools shows the same switch), then
 * restart. A person who has never opened a terminal never needs one; the
 * environment variable is only named when it is the thing keeping them off.
 *
 * @module features/connections/ui/ChatAppsOff
 */
import { useState } from 'react';
import { Route } from 'lucide-react';
import { toast } from 'sonner';
import { useUpdateConfig } from '@/layers/entities/config';
import { useRelayEnabledState } from '@/layers/entities/relay';
import { useAppStore, useTransport } from '@/layers/shared/model';
import { cn, restartDorkOS } from '@/layers/shared/lib';
import { Button, InlineCode } from '@/layers/shared/ui';

/** Which of the off states chat apps are in, once the config has answered. */
type ChatAppsOffReason = 'env' | 'failed' | 'restart' | 'off';

/**
 * Why chat apps aren't running, or null while they are (or the config hasn't
 * answered, or couldn't be read, which the caller shows itself).
 *
 * @param relay - The server's report on the message system.
 */
export function chatAppsOffReason(
  relay: ReturnType<typeof useRelayEnabledState>
): ChatAppsOffReason | null {
  if (relay.isLoading || relay.isError || relay.enabled) return null;
  // A failed start comes first: it only happens when something asked chat
  // apps to run (the setting or the variable), and a restart is its fix.
  if (relay.initError) return 'failed';
  if (relay.lockedByEnv) return 'env';
  if (relay.enabledInConfig === true) return 'restart';
  return 'off';
}

/**
 * The off state with its one step: turn chat apps on, restart to finish, or
 * (only when the environment decides) say which variable to remove.
 */
export function ChatAppsOff({
  relay,
  variant,
}: {
  relay: ReturnType<typeof useRelayEnabledState>;
  /** `line` is the quiet one-liner under the app list; `block` fills a page. */
  variant: 'line' | 'block';
}) {
  const transport = useTransport();
  const updateConfig = useUpdateConfig();
  const setRestartOverlayOpen = useAppStore((s) => s.setRestartOverlayOpen);
  const [restarting, setRestarting] = useState(false);
  const reason = chatAppsOffReason(relay);
  if (!reason) return null;

  const restart = async () => {
    setRestarting(true);
    try {
      await restartDorkOS(transport);
      setRestartOverlayOpen(true);
    } catch (err) {
      toast.error('Couldn’t restart DorkOS.', {
        description:
          err instanceof Error ? err.message : 'Not sure if it restarted. Try the button again.',
      });
    } finally {
      setRestarting(false);
    }
  };

  let message: React.ReactNode;
  let action: React.ReactNode = null;
  switch (reason) {
    case 'env':
      message = (
        <>
          Chat apps are off because <InlineCode>DORKOS_RELAY_ENABLED</InlineCode> is set on this
          computer, and it decides over the setting. Remove it, then start DorkOS again.
        </>
      );
      break;
    case 'failed':
      message = 'Chat apps didn’t start. Restarting DorkOS tries again.';
      action = (
        <Button size="sm" variant="secondary" disabled={restarting} onClick={() => void restart()}>
          {restarting ? 'Restarting…' : 'Restart DorkOS'}
        </Button>
      );
      break;
    case 'restart':
      message =
        'Chat apps turn on when DorkOS restarts. Restarting stops anything running right now.';
      action = (
        <Button size="sm" disabled={restarting} onClick={() => void restart()}>
          {restarting ? 'Restarting…' : 'Restart DorkOS'}
        </Button>
      );
      break;
    case 'off':
      message =
        'Chat apps are off. Turn them on to reach your agents from Telegram, Slack, or a webhook.';
      action = (
        <Button
          size="sm"
          disabled={updateConfig.isPending}
          onClick={() => updateConfig.mutate({ relay: { enabled: true } })}
        >
          {updateConfig.isPending ? 'Turning on…' : 'Turn on chat apps'}
        </Button>
      );
      break;
  }

  return (
    <div
      data-testid="chat-apps-off"
      data-reason={reason}
      className={cn(
        variant === 'line'
          ? 'flex flex-wrap items-center gap-x-3 gap-y-2'
          : 'flex flex-col items-center gap-3 p-8 text-center'
      )}
    >
      {variant === 'block' && <Route className="text-muted-foreground/50 size-8" aria-hidden />}
      <p
        className={cn('text-muted-foreground', variant === 'line' ? 'text-xs' : 'text-sm')}
        role="status"
      >
        {message}
      </p>
      {action}
      {updateConfig.isError && (
        <p role="alert" className="text-destructive text-xs">
          Couldn’t save that. Check that DorkOS is running, then try again.
        </p>
      )}
    </div>
  );
}
