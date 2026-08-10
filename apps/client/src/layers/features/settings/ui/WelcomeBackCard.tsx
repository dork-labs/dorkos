/**
 * The welcome-back switch in Settings → Preferences (spec `team-room-home` D5.2).
 *
 * Its own card, deliberately: everything else on that tab is a display
 * preference this browser remembers, and this one is a setting the server keeps,
 * so it follows the person to every device they open DorkOS on. Grouping it with
 * the local toggles would quietly imply otherwise.
 *
 * Two switches, and the second one is the only preference on this tab that
 * spends money. Notes are free — they are read off session state — so that
 * switch is about noise. An OFFER cannot be known about without asking the
 * agent, which runs it for a turn, so its own row says that in the sentence
 * rather than leaving it to the docs, and it ships off.
 *
 * The offers row is hidden while the notes are off, because there is nothing for
 * an offer to ride on: a switch that cannot do anything is a switch that should
 * not be there.
 *
 * How long an absence has to be, and how many notes one return may produce, stay
 * in the config file — see `contributing/configuration.md`. The sentence under
 * the first label names the threshold actually in force, so a person who changed
 * it in the file is not read back the shipped default.
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
  const {
    enabled,
    absenceThresholdMinutes,
    offersEnabled,
    setEnabled,
    setOffersEnabled,
    isAvailable,
  } = useWelcomeBack();

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
        {enabled && (
          <SwitchSettingRow
            label="Next-step offers"
            description="A note can end with one thing your agent wants you to decide. There is no way to know it has one without asking, so each offer runs that agent for a turn — at most one turn per agent that left you a note."
            checked={offersEnabled}
            onCheckedChange={setOffersEnabled}
          />
        )}
      </FieldCardContent>
    </FieldCard>
  );
}
