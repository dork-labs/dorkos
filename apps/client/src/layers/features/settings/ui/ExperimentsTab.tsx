/**
 * Settings → Advanced → Experiments — the staged opt-ins, rendered from the server's list.
 *
 * Most rows write the registered config path. Shared browser uses its authenticated
 * native startup operation, because a stored boolean cannot establish startup capability.
 * This tab otherwise holds no table of individual experiments. The server sends an
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
import { useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTransport, useAppStore, CONFIG_WRITE_MUTATION_KEY } from '@/layers/shared/model';
import { useConfig, useUpdateConfig, configKeys } from '@/layers/entities/config';

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
    parts.push(`${envOverride} on this computer controls this switch.`);
  }
  return parts.join(' ');
}

/** The Experiments tab: things you can try before they are finished. */
export function ExperimentsTab() {
  const { data: config, isLoading } = useConfig();
  const updateConfig = useUpdateConfig();
  const transport = useTransport();
  const queryClient = useQueryClient();
  const browserWriteEntered = useRef(false);
  const browserChoice = useMutation({
    mutationKey: CONFIG_WRITE_MUTATION_KEY,
    mutationFn: async (choice: boolean | { chromeUserAgent: boolean }) => {
      const original = transport.browserProduction;
      if (!original) throw new Error('Shared browser cannot be changed on this computer yet.');
      // This original authenticated operation is retained through its actual settlement.
      // Stored choice and a generic config patch cannot authorize native startup.
      return typeof choice === 'boolean'
        ? original.setBrowserRuntimeEnabled(choice, new AbortController().signal)
        : original.setBrowserRuntimeEnabled(false, new AbortController().signal, choice);
    },
    onSettled: () => {
      browserWriteEntered.current = false;
      void queryClient.invalidateQueries({ queryKey: configKeys.current() });
      void queryClient.invalidateQueries({ queryKey: ['browser'] });
    },
  });
  function changeBrowserChoice(enabled: boolean) {
    if (browserWriteEntered.current || !transport.browserProduction) return;
    browserWriteEntered.current = true;
    browserChoice.mutate(enabled);
  }
  function changeBrowserIdentityChoice(chromeUserAgent: boolean) {
    if (
      browserWriteEntered.current ||
      !transport.browserProduction ||
      !runtimeIsOff ||
      runtimeStatus.isFetching ||
      runtimeStatus.isError
    )
      return;
    browserWriteEntered.current = true;
    browserChoice.mutate({ chromeUserAgent });
  }
  const devtoolsOpen = useAppStore((s) => s.devtoolsOpen);
  const toggleDevtools = useAppStore((s) => s.toggleDevtools);

  const experiments = config?.experiments ?? [];
  const sharedBrowserEnabled = experiments.some(
    ({ key, enabled }) => key === 'browser.enabled' && enabled
  );

  const chromeChoiceListed = experiments.some(({ key }) => key === 'browser.chromeUserAgent');
  const runtimeStatus = useQuery({
    queryKey: ['browser', 'runtime-status'],
    enabled: chromeChoiceListed && !!transport.browserProduction,
    retry: false,
    queryFn: ({ signal }) => {
      const original = transport.browserProduction;
      if (!original) throw new Error('Shared browser is unavailable.');
      return original.readBrowserRuntimeStatus(signal);
    },
  });
  const runtimeIsOff =
    runtimeStatus.data?.state === 'disabled' && runtimeStatus.data.enabled === false;

  return (
    <div className="space-y-6" data-testid="experiments-tab">
      <p className="text-muted-foreground text-xs">Unfinished features you can try early.</p>

      {/* Pure client state — no server config in the loop — so it stays
          reachable exactly when the Server tab (config-dependent) is not: a
          restart, a slow boot, or the server refusing to answer at all
          (DOR-1758 follow-up). This is the one developer-facing switch in the
          System group that a non-dev build never needs, so it leads before the
          server-sent list rather than waiting behind it. */}
      <FieldCard>
        <FieldCardContent>
          <SwitchSettingRow
            label="Show dev tools"
            description="Opens a panel showing what the app has loaded."
            checked={devtoolsOpen}
            onCheckedChange={() => toggleDevtools()}
          />
        </FieldCardContent>
      </FieldCard>

      {/* While the config is in flight, say nothing: the empty message makes a
          claim ("nothing is waiting on you") that is false mid-fetch. */}
      {isLoading ? null : experiments.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="experiments-empty">
          No experiments right now. New ones show up here.
        </p>
      ) : (
        <FieldCard>
          <FieldCardContent>
            {experiments.map(({ key, ...experiment }) => (
              <SwitchSettingRow
                key={key}
                label={experiment.title}
                description={rowDescription(
                  experiment.description,
                  experiment.costNote,
                  experiment.envOverride
                )}
                checked={experiment.enabled}
                onCheckedChange={(value) =>
                  key === 'browser.enabled'
                    ? changeBrowserChoice(value)
                    : key === 'browser.chromeUserAgent'
                      ? changeBrowserIdentityChoice(value)
                      : updateConfig.mutate(buildNestedPatch(key, value))
                }
                disabled={
                  experiment.lockedByEnv ||
                  (key === 'browser.chromeUserAgent' &&
                    (sharedBrowserEnabled ||
                      !runtimeIsOff ||
                      runtimeStatus.isFetching ||
                      runtimeStatus.isError ||
                      browserChoice.isPending ||
                      !transport.browserProduction)) ||
                  (key === 'browser.enabled' &&
                    (browserChoice.isPending || !transport.browserProduction))
                }
              />
            ))}
          </FieldCardContent>
        </FieldCard>
      )}

      {browserChoice.isError ? (
        <p role="alert" className="text-sm">
          Shared browser could not be changed. Refresh before trying again.
        </p>
      ) : null}
      <p className="text-muted-foreground text-xs">
        These start off. Each one graduates or goes away.
      </p>
    </div>
  );
}
