/**
 * The welcome-back switch in Settings → Preferences (spec `team-room-home` D5.2).
 *
 * Its own card, deliberately: everything else on that tab is a display
 * preference this browser remembers, and this one is a setting the server keeps,
 * so it follows the person to every device they open DorkOS on. Grouping it with
 * the local toggles would quietly imply otherwise.
 *
 * The switch is the whole control. How long an absence has to be, and how many
 * notes one return may produce, stay in the config file for v1 — see
 * `contributing/configuration.md`. The sentence under the label names the
 * threshold actually in force, so a person who changed it in the file is not
 * read back the shipped default.
 *
 * @module features/settings/ui/WelcomeBackCard
 */
import { FieldCard, FieldCardContent, SwitchSettingRow } from '@/layers/shared/ui';
import { useWelcomeBack } from '@/layers/entities/config';

/**
 * Say a minute count the way a person would say it.
 *
 * @param minutes - The stored threshold.
 */
function humanizeMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours === 1 ? 'an hour' : `${hours} hours`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}

/**
 * The welcome-back card.
 *
 * Renders nothing at all when the server does not report the setting — an older
 * server, or Obsidian, where the write would save nothing. A switch that ticks
 * and forgets is worse than no switch.
 */
export function WelcomeBackCard() {
  const { enabled, absenceThresholdMinutes, setEnabled, isAvailable } = useWelcomeBack();

  if (!isAvailable) return null;

  return (
    <FieldCard>
      <FieldCardContent>
        <SwitchSettingRow
          label="Welcome-back notes"
          description={`Your agents may leave a short note in your team channel when you come back after ${humanizeMinutes(absenceThresholdMinutes)} away. Off means no note, and no work done deciding there was nothing to say. This one follows you to every device.`}
          checked={enabled}
          onCheckedChange={setEnabled}
        />
      </FieldCardContent>
    </FieldCard>
  );
}
