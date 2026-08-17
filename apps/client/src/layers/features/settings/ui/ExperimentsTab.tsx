/**
 * Settings → Experiments — the staged opt-ins, rendered from the server's list.
 *
 * This tab holds no knowledge of any individual experiment. The server sends an
 * ordered array of resolved entries (`config.experiments`), each carrying its own
 * prose, its position, and whether the position is even the setting's to give;
 * this file draws one switch per entry and writes the path back. That is what
 * lets a flag be added, or graduate and vanish, without touching the client.
 *
 * The list is expected to empty out. Every experiment either graduates to
 * on-by-default and has its flag deleted, or is withdrawn — so "nothing here"
 * is the success state, and the empty message says so instead of apologising.
 *
 * @module features/settings/ui/ExperimentsTab
 */
import { FieldCard, FieldCardContent, SwitchSettingRow } from '@/layers/shared/ui';
import { useConfig, useUpdateConfig } from '@/layers/entities/config';

/**
 * Turn a dot-path into the nested patch body `PATCH /api/config` deep-merges.
 *
 * `'runtimes.claudeCode.persistentSession'` with `true` becomes
 * `{ runtimes: { claudeCode: { persistentSession: true } } }`. Built from the
 * path rather than from a table of known experiments, because the whole point of
 * the server-side registry is that this file does not have one.
 *
 * @param path - Dot-path of the boolean setting.
 * @param value - The position to write.
 * @returns The patch body.
 */
export function buildNestedPatch(path: string, value: boolean): Record<string, unknown> {
  const parts = path.split('.');
  return parts.reduceRight<unknown>((acc, part) => ({ [part]: acc }), value) as Record<
    string,
    unknown
  >;
}

/**
 * What a row says about itself once the setting and reality are compared.
 *
 * A variable that has taken the decision away has to be said out loud — BY NAME,
 * so the one person who can unset it knows what to unset — or the disabled
 * switch reads as a bug. Same sentence the background-systems rows use, for the
 * same reason.
 *
 * @param description - The entry's own description.
 * @param costNote - The cost, when the entry states one.
 * @param envOverride - The variable deciding it, when one has taken over.
 * @returns The description line for the row.
 */
function rowDescription(
  description: string,
  costNote: string | undefined,
  envOverride: string | undefined
): string {
  const parts = [description];
  if (costNote !== undefined) parts.push(costNote);
  if (envOverride !== undefined) {
    parts.push(`Right now ${envOverride} on this machine decides it, so this switch cannot.`);
  }
  return parts.join(' ');
}

/** The Experiments tab: things you can try before they are finished. */
export function ExperimentsTab() {
  const { data: config, isLoading } = useConfig();
  const updateConfig = useUpdateConfig();

  const experiments = config?.experiments ?? [];

  return (
    <div className="space-y-6" data-testid="experiments-tab">
      <p className="text-muted-foreground text-xs">
        Things we are still proving out. Not finished being proved, so you get to decide.
      </p>

      {/* While the config is in flight, say nothing: the empty message makes a
          claim ("nothing is waiting on you") that is false mid-fetch. */}
      {isLoading ? null : experiments.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="experiments-empty">
          Nothing’s cooking right now. Experiments show up here while we prove them out.
        </p>
      ) : (
        <FieldCard>
          <FieldCardContent>
            {experiments.map((experiment) => (
              <SwitchSettingRow
                key={experiment.key}
                label={experiment.title}
                description={rowDescription(
                  experiment.description,
                  experiment.costNote,
                  experiment.envOverride
                )}
                checked={experiment.enabled}
                onCheckedChange={(value) =>
                  updateConfig.mutate(buildNestedPatch(experiment.key, value))
                }
                disabled={experiment.lockedByEnv}
              />
            ))}
          </FieldCardContent>
        </FieldCard>
      )}

      <p className="text-muted-foreground text-xs">
        These are off until you turn them on. Each one graduates or goes away.
      </p>
    </div>
  );
}
