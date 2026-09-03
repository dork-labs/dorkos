/**
 * Notifications settings — every way DorkOS can get your attention, in one place.
 *
 * They used to be scattered: the turn-finished chime was a browser preference on
 * the Preferences tab AND a switch inside a session's status popover, and
 * nothing else had a home at all. One tab, because the question a person is
 * asking is a single one — how loud may this be? — and answering it should not
 * mean hunting.
 *
 * **The bold labels are the scan layer, and every sentence under one is short
 * enough to skip** (DOR-1757). This tab used to open onto three sentences of
 * framing above six rows that each carried a full sentence of their own — the
 * best copy in the app, stacked six deep until it read as a wall. The labels
 * carry the model now ("knock" for what is waiting on you, "chime" for news),
 * and the one genuinely long thing here — how to get DorkOS onto a phone at all
 * — sits behind a disclosure, because it is a job you do once.
 *
 * @module features/settings/ui/tabs/NotificationsTab
 */
import { useState } from 'react';
import { useNotificationPrefs } from '@/layers/entities/config';
import { ReachMeSection } from '@/layers/features/notifications';
import { isDesktopShell } from '@/layers/shared/lib';
import { useBrowserNotificationPermission } from '@/layers/shared/model';
import {
  Button,
  CollapsibleFieldCard,
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
  const [phoneHelpOpen, setPhoneHelpOpen] = useState(false);

  return (
    <div className="space-y-6">
      {/* No intro and no heading: the Settings dialog draws the panel's own
          header, and the labels below say which sound is which. */}
      <FieldCard>
        <FieldCardContent>
          <SwitchSettingRow
            label="Knock when an agent needs you"
            description="A soft double-knock when something waits on you."
            checked={prefs.sounds.knock}
            onCheckedChange={(on) => setPrefs({ sounds: { knock: on } })}
            disabled={isPending}
          />

          <SwitchSettingRow
            label="Chime when everything is answered"
            description="A gentle sound when nothing is waiting any more."
            checked={prefs.sounds.allClear}
            onCheckedChange={(on) => setPrefs({ sounds: { allClear: on } })}
            disabled={isPending}
          />

          <SwitchSettingRow
            label="Chime every time a turn finishes"
            description="Every reply, in every session. Noisy with several agents."
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
            description="Anything waiting on you always gets through."
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
          seen the list it feeds. Collapsed, because it is a job you do once and
          then never read again — and as a permanent paragraph it was the
          longest thing on the tab. */}
      <CollapsibleFieldCard
        open={phoneHelpOpen}
        onOpenChange={setPhoneHelpOpen}
        trigger="Get these on your phone"
      >
        <ol className="text-muted-foreground list-decimal space-y-1.5 pl-4 text-xs">
          <li>Open DorkOS on your phone, at your Remote access address.</li>
          <li>
            Choose &ldquo;Add to Home Screen&rdquo;. On iPhone this step is required before
            notifications work at all.
          </li>
          <li>Open Settings there and add it as a device above.</li>
        </ol>
      </CollapsibleFieldCard>
    </div>
  );
}

/**
 * What to say about the browser's permission — one short line per state, each
 * with the way out of it.
 *
 * "Blocked" is the only state DorkOS cannot fix on its own, because a browser
 * that has been told no does not ask again, so it is the one line that has to
 * name where to go instead.
 *
 * @param permission - What the browser says.
 * @param inDesktopShell - Whether this is the desktop app, which has its own.
 */
function browserPermissionDescription(
  permission: 'granted' | 'denied' | 'default' | 'unsupported',
  inDesktopShell: boolean
): string {
  if (inDesktopShell) {
    return 'The desktop app shows its own notifications.';
  }
  if (permission === 'granted') {
    return 'Allowed, even while this tab is hidden.';
  }
  if (permission === 'denied') {
    return 'Blocked. Change it in your browser’s settings for this site.';
  }
  if (permission === 'unsupported') {
    return 'This browser cannot show notifications.';
  }
  return 'Not turned on yet.';
}
