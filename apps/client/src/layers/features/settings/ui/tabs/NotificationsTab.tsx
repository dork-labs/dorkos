/**
 * Notifications settings — every way DorkOS can get your attention, in one place.
 *
 * They used to be scattered: the turn-finished chime was a browser preference on
 * the Preferences tab AND a switch inside a session's status popover, and
 * nothing else had a home at all. One tab, because the question a person is
 * asking is a single one — how loud may this be? — and answering it should not
 * mean hunting.
 *
 * @module features/settings/ui/tabs/NotificationsTab
 */
import { useNotificationPrefs } from '@/layers/entities/config';
import { ReachMeSection } from '@/layers/features/notifications';
import { isDesktopShell } from '@/layers/shared/lib';
import { useBrowserNotificationPermission } from '@/layers/shared/model';
import {
  Button,
  FieldCard,
  FieldCardContent,
  SettingRow,
  SwitchSettingRow,
} from '@/layers/shared/ui';

/** How DorkOS gets your attention. */
export function NotificationsTab() {
  const { prefs, setPrefs, isPending } = useNotificationPrefs();
  const { permission, request } = useBrowserNotificationPermission();
  const inDesktopShell = isDesktopShell();

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        {/* No heading: the Settings dialog draws the panel's own header. */}
        <p className="text-muted-foreground text-xs">
          Agents work while you do something else, so DorkOS has to be able to reach you — and to
          stay quiet the rest of the time. A knock means something has stopped and is waiting on
          you. Everything else is news.
        </p>
      </div>

      <FieldCard>
        <FieldCardContent>
          <SwitchSettingRow
            label="Knock when an agent needs you"
            description="A soft double-knock the moment something stops and waits for your answer."
            checked={prefs.sounds.knock}
            onCheckedChange={(on) => setPrefs({ sounds: { knock: on } })}
            disabled={isPending}
          />

          <SwitchSettingRow
            label="Chime when everything is answered"
            description="A gentle sound when the last thing waiting on you is cleared."
            checked={prefs.sounds.allClear}
            onCheckedChange={(on) => setPrefs({ sounds: { allClear: on } })}
            disabled={isPending}
          />

          <SwitchSettingRow
            label="Chime every time a turn finishes"
            description="Plays whenever an agent finishes replying, in any session. Off to start with — with a few agents running it is a lot of sound."
            checked={prefs.sounds.turnEnd}
            onCheckedChange={(on) => setPrefs({ sounds: { turnEnd: on } })}
            disabled={isPending}
          />
        </FieldCardContent>
      </FieldCard>

      <FieldCard>
        <FieldCardContent>
          <SettingRow
            label="Notifications from your browser"
            description={browserPermissionDescription(permission, inDesktopShell)}
          >
            {!inDesktopShell && permission === 'default' && (
              <Button variant="outline" size="sm" onClick={() => void request()}>
                Turn on
              </Button>
            )}
          </SettingRow>

          <SwitchSettingRow
            label="Tell me when something finishes while I am away"
            description="Show a notification when a turn finishes or a message arrives and you are looking at something else. Things that are blocked on you always get through."
            checked={prefs.notifyOnTurnCompleteWhileAway}
            onCheckedChange={(on) => setPrefs({ notifyOnTurnCompleteWhileAway: on })}
            disabled={isPending}
          />
        </FieldCardContent>
      </FieldCard>

      {/* The escalation delay and the devices it reaches, drawn by the
          notifications feature: the delay is meaningless without somewhere to
          escalate to, and the push flow is that feature's model. */}
      <ReachMeSection />

      {/* Last, and deliberately after the device list: this is the how-to for
          getting a phone INTO that list, so it only makes sense once you have
          seen the list it feeds. */}
      <p className="text-muted-foreground text-xs">
        On a phone, open DorkOS using your tunnel address (see Tunnel Setup), then choose &ldquo;Add
        to Home Screen&rdquo; to install it like an app: full screen, with its own icon. On iPhone
        that step is required before notifications work at all — once it is installed, open Settings
        there and add it as a device above.
      </p>
    </div>
  );
}

/**
 * What to say about the browser's permission, in plain words and with a way out
 * of every state.
 *
 * "Blocked" gets the longest sentence on purpose: it is the only state DorkOS
 * cannot fix, because a browser that has been told no does not ask again.
 *
 * @param permission - What the browser says.
 * @param inDesktopShell - Whether this is the desktop app, which has its own.
 */
function browserPermissionDescription(
  permission: 'granted' | 'denied' | 'default' | 'unsupported',
  inDesktopShell: boolean
): string {
  if (inDesktopShell) {
    return 'The desktop app shows its own notifications, so this setting does not apply here.';
  }
  if (permission === 'granted') {
    return 'Allowed. DorkOS can show a notification while this tab is hidden.';
  }
  if (permission === 'denied') {
    return 'Blocked. Your browser is set to refuse notifications from DorkOS, and it will not ask again — you can change that in your browser’s settings for this site.';
  }
  if (permission === 'unsupported') {
    return 'This browser cannot show notifications.';
  }
  return 'Not turned on yet. DorkOS asks the first time it would actually be useful, or you can turn it on here.';
}
