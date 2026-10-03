import { FieldCard, FieldCardContent, SettingRow, Switch } from '@/layers/shared/ui';
import { useCreditsFor, type CreditsForRow } from '../model/use-credits-for';
import { CreditsNotices } from './CreditsNotices';

/**
 * "Use credits for" — one switch per runtime DorkOS credits can reach.
 *
 * Each switch is a view onto that runtime's recorded Runs on choice, not a
 * setting of its own (see `use-credits-for`). It renders only where credits can
 * be chosen (linked, not switched off), and only for the runtimes the server
 * reports as wired:
 * on every other install the section is absent rather than disabled, because a
 * switch nobody can use is worse than no switch, and one that silently did
 * nothing would be a lie about where somebody's money goes.
 */
export function UseCreditsFor() {
  const { rows, pending, failure, setOn } = useCreditsFor();

  if (rows.length === 0) return null;

  return (
    <FieldCard>
      <FieldCardContent className="space-y-3">
        <p className="text-muted-foreground text-xs tracking-wide uppercase">Use credits for</p>
        {/* Choices DorkOS made for the person, and the one offer an earlier
            link is owed, said where the switches are. */}
        <CreditsNotices />
        {rows.map((row) => (
          <SettingRow key={row.runtime} label={row.name} description={rowDescription(row)}>
            <Switch
              checked={row.on}
              disabled={pending || (row.on ? !row.canTurnOff : !row.canTurnOn)}
              onCheckedChange={(next) => setOn(row.runtime, next)}
              aria-label={`Use credits for ${row.name}`}
            />
          </SettingRow>
        ))}
        {failure !== null && (
          <p className="text-destructive text-sm" role="alert">
            {failure}
          </p>
        )}
      </FieldCardContent>
    </FieldCard>
  );
}

/**
 * What a row says under the runtime's name: what it runs on now, and what
 * moving the switch would do.
 *
 * @param row - The runtime's row.
 */
function rowDescription(row: CreditsForRow): string {
  const sentence = rowSentence(row);
  return row.caveat ? `${sentence} ${row.caveat}` : sentence;
}

/**
 * The row's own sentence, before what the runtime does not get on credits.
 *
 * @param row - The runtime's row.
 */
function rowSentence(row: CreditsForRow): string {
  if (row.on && row.unreachable) {
    return `${row.name} is set to DorkOS credits, which can't run it right now, so its new work stops instead of using your own sign-in. Turn this off to use its own sign-in.`;
  }
  if (!row.on) {
    return row.previousSignIn === null
      ? `New ${row.name} work uses its own sign-in.`
      : `New ${row.name} work uses ${row.previousSignIn}.`;
  }
  const back =
    row.previousSignIn === null
      ? 'Turning this off puts it back on its own sign-in.'
      : `Turning this off puts it back on ${row.previousSignIn}.`;
  if (row.chosenBy === 'default') {
    return `DorkOS turned this on when you linked, because ${row.name} had no sign-in. ${back}`;
  }
  if (row.scope === 'runtime') {
    return `${row.name} runs on your DorkOS credits, conversations already going included. ${back} It can't be switched while ${row.name} is in the middle of a reply.`;
  }
  return row.hasAccountPicks
    ? `New ${row.name} work runs on your DorkOS credits unless an agent or a session picks another account. ${back}`
    : `New ${row.name} conversations run on your DorkOS credits. ${back}`;
}
