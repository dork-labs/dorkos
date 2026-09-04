/**
 * "Reach me somewhere else" — the escalation delay and the devices it reaches
 * (spec `notification-system` task 4.3, ADR 260819-234829).
 *
 * One card rather than two, because the knob and the devices are one question: a
 * delay is meaningless without somewhere to escalate TO, and a subscribed phone
 * is meaningless without a delay to trigger it. Keeping them apart is how a
 * person ends up setting a timer that can never fire and never being told.
 *
 * It lives in the notifications feature rather than in the settings tab that
 * shows it, because the push flow is this feature's model and a feature may not
 * reach into another feature's hooks. Rendering a sibling feature's component is
 * the composition the layer rule does allow.
 *
 * @module features/notifications/ui/ReachMeSection
 */
import type { EscalationDelay } from '@dorkos/shared/config-schema';
import type { PushSubscriptionDTO } from '@dorkos/shared/notification-schemas';
import { useBindings } from '@/layers/entities/binding';
import { useNotificationPrefs } from '@/layers/entities/config';
import { formatRelativeTime } from '@/layers/shared/lib';
import {
  Button,
  FieldCard,
  FieldCardContent,
  SegmentedControl,
  SegmentedControlItem,
  SettingRow,
} from '@/layers/shared/ui';
import { usePushSubscription, type PushAvailability } from '../model/use-push-subscription';

/** The escalation ladder's rungs, in the order they are shown. */
const ESCALATION_CHOICES: { value: EscalationDelay; label: string }[] = [
  { value: 1, label: '1 min' },
  { value: 2, label: '2 min' },
  { value: 5, label: '5 min' },
  { value: 15, label: '15 min' },
  { value: 'never', label: 'Never' },
];

/** Segmented controls speak strings; the setting is a number or the word `never`. */
function toDelay(raw: string): EscalationDelay {
  return raw === 'never' ? 'never' : (Number(raw) as EscalationDelay);
}

/** How DorkOS reaches you once you have walked away from this screen. */
export function ReachMeSection() {
  const { prefs, setPrefs, isPending } = useNotificationPrefs();
  const push = usePushSubscription();
  const bindings = useBindings();

  const chatCanCarry = (bindings.data ?? []).some(
    (binding) => binding.enabled && binding.canInitiate
  );
  const off = prefs.escalation.phoneAfterMinutes === 'never';
  // Both answers, or neither. Warning "nothing can carry that" off a list that
  // has simply not loaded yet would flash an alarm at somebody whose phone IS
  // subscribed — and the first thing they would do is doubt the setting.
  const knowsWhatCanCarry = push.devicesLoaded && bindings.isSuccess;

  return (
    <FieldCard>
      <FieldCardContent>
        <SettingRow
          orientation="vertical"
          label="Try to reach me somewhere else after"
          // One line, on a tab whose whole point is that its bold labels are
          // scannable (DOR-1757). What went: that a new time applies from the
          // next thing onward, and that Never stops a countdown already
          // running. Both are true, both are fine print about a knob somebody
          // has already turned, and neither changes the choice being made.
          description="DorkOS then pings your devices and chat apps. Answer anywhere to quiet the rest."
        >
          <SegmentedControl
            value={String(prefs.escalation.phoneAfterMinutes)}
            onValueChange={(raw) => setPrefs({ escalation: { phoneAfterMinutes: toDelay(raw) } })}
            disabled={isPending}
            aria-label="How long to wait before trying another way of reaching you"
          >
            {ESCALATION_CHOICES.map((choice) => (
              <SegmentedControlItem key={String(choice.value)} value={String(choice.value)}>
                {choice.label}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </SettingRow>

        {knowsWhatCanCarry && !off && push.devices.length === 0 && !chatCanCarry && (
          <p className="text-muted-foreground text-xs" role="status">
            Nothing can carry that yet. Add this device below, or connect a chat app under
            Connections and let an agent start conversations there.
          </p>
        )}

        <SettingRow
          orientation="vertical"
          label="Devices DorkOS can reach"
          description={availabilityCopy(push.availability)}
        >
          <div className="w-full space-y-3">
            {push.devices.length > 0 && (
              <ul className="divide-border divide-y" aria-label="Subscribed devices">
                {push.devices.map((device) => (
                  <li
                    key={device.id}
                    className="flex items-center justify-between gap-4 py-2 first:pt-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm">{deviceName(device, push.localDeviceId)}</p>
                      <p className="text-muted-foreground text-xs">
                        Added {formatRelativeTime(device.createdAt)}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={push.isPending}
                      onClick={() => void push.remove(device.id)}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ul>
            )}

            {push.availability === 'available' && push.localDeviceId === null && (
              <Button
                variant="outline"
                size="sm"
                disabled={push.isPending}
                onClick={() => void push.subscribe()}
              >
                Add this device
              </Button>
            )}

            {push.error !== null && (
              <p className="text-destructive text-xs" role="alert">
                {push.error}
              </p>
            )}
          </div>
        </SettingRow>
      </FieldCardContent>
    </FieldCard>
  );
}

/**
 * What to say about this browser's ability to be reached at all.
 *
 * Each state gets its own sentence rather than one hedge, because the answer to
 * "what do I do about it" is different in every one of them — and in three of
 * them it is "nothing, and that is fine".
 *
 * @param availability - What the push hook worked out about this browser.
 */
function availabilityCopy(availability: PushAvailability): string {
  switch (availability) {
    case 'available':
      return 'Each browser you add here can be notified even when DorkOS is closed. Adding your phone’s browser is the point of this.';
    case 'desktop-shell':
      return 'The desktop app is already running and shows its own notifications, so it does not need to be added here. Add your phone’s browser instead.';
    case 'unsupported':
      return 'This browser cannot receive notifications while DorkOS is closed. Devices you added from another browser still work.';
    case 'insecure-context':
      return 'Browsers only allow this over a secure connection. Open DorkOS at localhost, or over HTTPS, to add this device.';
    case 'server-unavailable':
      return 'DorkOS could not set up push notifications on this computer, so no device can be added right now.';
  }
}

/**
 * What to call one subscribed browser.
 *
 * The push service's hostname is all the server will say — an endpoint is a
 * capability and never leaves the machine — so "this device" is the only label
 * with real meaning, and it is the one a person is looking for.
 */
function deviceName(device: PushSubscriptionDTO, localDeviceId: string | null): string {
  if (device.id === localDeviceId) return 'This device';
  return device.service === 'unknown' ? 'Another device' : `Another device (${device.service})`;
}
