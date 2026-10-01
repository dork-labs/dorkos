import { FieldCard, FieldCardContent, SettingRow, Switch } from '@/layers/shared/ui';
import { useCreditsFor, type CreditsForRow } from '../model/use-credits-for';

/**
 * "Use credits for" — one switch per runtime DorkOS credits can reach.
 *
 * Each switch is a view onto that runtime's own default sign-in, not a setting
 * of its own (see `use-credits-for`). It renders only where the server reports
 * the credits path switched on, and only for the runtimes it reports as wired:
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
  if (!row.on) return `${row.name} uses its own sign-in.`;
  if (!row.canTurnOff) {
    // The true answer for a build where credits are one process-wide token
    // held in memory: nothing here can hand the runtime back, the token expires
    // on its own, and pretending otherwise would mislead somebody about who
    // pays for their next turn.
    return `${row.name} runs on your DorkOS credits. They stay on until the current pass runs out, DorkOS restarts, or you unlink this computer. Then this switches off, and you can turn it on again.`;
  }
  return row.previousSignIn === null
    ? `${row.name} runs on your DorkOS credits.`
    : `${row.name} runs on your DorkOS credits. Turning this off puts it back on ${row.previousSignIn}.`;
}
