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
  if (!row.on) {
    return row.previousSignIn === null
      ? `New ${row.name} work uses its own sign-in.`
      : `New ${row.name} work uses ${row.previousSignIn}.`;
  }
  const back =
    row.previousSignIn === null
      ? 'Turning this off puts it back on its own sign-in.'
      : `Turning this off puts it back on ${row.previousSignIn}.`;
  return row.chosenBy === 'default'
    ? `DorkOS turned this on when you linked, because ${row.name} had no sign-in. ${back}`
    : `New ${row.name} work runs on your DorkOS credits unless an agent or a session picks another account. ${back}`;
}
