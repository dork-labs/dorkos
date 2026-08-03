import { useMemo, useState } from 'react';
import {
  FieldCard,
  FieldCardContent,
  Input,
  SettingRow,
  SwitchSettingRow,
} from '@/layers/shared/ui';
import {
  useAdapterCatalog,
  useToggleAdapter,
  useUpdateAdapterConfig,
} from '@/layers/entities/relay';

/** The two numbers this card persists. */
type PolicyKey = 'maxConcurrent' | 'defaultTimeoutMs';

/** What the values are before anyone has changed them. */
const POLICY_DEFAULTS: Record<PolicyKey, number> = {
  maxConcurrent: 3,
  defaultTimeoutMs: 300000,
};

/** The range each value is allowed to take, shared by the input and the guard. */
const POLICY_BOUNDS: Record<PolicyKey, { min: number; max: number }> = {
  maxConcurrent: { min: 1, max: 20 },
  defaultTimeoutMs: { min: 10000, max: 3600000 },
};

/** One minute, in the milliseconds the config stores. */
const MS_PER_MINUTE = 60000;

/**
 * What happens when a message arrives, for every messaging connection at once.
 *
 * These are region rules, not per-connection ones: they govern the built-in
 * delivery that turns an incoming message into a working session, so they
 * belong beside the connections they apply to rather than buried in settings.
 */
export function MessagePolicyCard() {
  const { data: catalog = [] } = useAdapterCatalog(true);
  const { mutate: toggle } = useToggleAdapter();
  const { mutate: updateConfig } = useUpdateAdapterConfig();

  const delivery = useMemo(
    () =>
      catalog.find((e) => e.manifest.category === 'internal' && e.manifest.type === 'claude-code')
        ?.instances[0],
    [catalog]
  );

  const persisted: Record<PolicyKey, number> = {
    maxConcurrent: Number(delivery?.config?.maxConcurrent ?? POLICY_DEFAULTS.maxConcurrent),
    defaultTimeoutMs: Number(
      delivery?.config?.defaultTimeoutMs ?? POLICY_DEFAULTS.defaultTimeoutMs
    ),
  };

  // Typing is local; the value is saved when the field loses focus, so a
  // half-typed number is never persisted.
  const [draftMax, setDraftMax] = useState<string | null>(null);
  const [draftMinutes, setDraftMinutes] = useState<string | null>(null);

  function commit(key: PolicyKey, raw: number) {
    const bounds = POLICY_BOUNDS[key];
    const inBounds = !Number.isNaN(raw) && raw >= bounds.min && raw <= bounds.max;
    if (delivery && inBounds && raw !== persisted[key]) {
      updateConfig({ id: delivery.id, config: { [key]: raw } });
    }
  }

  if (!delivery) return null;

  return (
    <section aria-labelledby="connections-policy" className="space-y-3">
      <div>
        <h3 id="connections-policy" className="text-sm font-semibold">
          When messages arrive
        </h3>
        <p className="text-muted-foreground mt-1 text-sm">
          These apply to every messaging connection above.
        </p>
      </div>
      <FieldCard>
        <FieldCardContent>
          <SwitchSettingRow
            label="Start a Claude Code session"
            description="An incoming message puts your agent to work straight away."
            checked={delivery.enabled}
            onCheckedChange={(enabled) => toggle({ id: delivery.id, enabled })}
          />
          <SettingRow
            label="Most sessions at once"
            description="Messages beyond this wait their turn instead of piling on."
          >
            <Input
              type="number"
              aria-label="Most sessions at once"
              min={POLICY_BOUNDS.maxConcurrent.min}
              max={POLICY_BOUNDS.maxConcurrent.max}
              value={draftMax ?? String(persisted.maxConcurrent)}
              onChange={(e) => setDraftMax(e.target.value)}
              onBlur={(e) => {
                commit('maxConcurrent', Number(e.target.value));
                setDraftMax(null);
              }}
              className="w-24"
            />
          </SettingRow>
          <SettingRow
            label="Give up after"
            description="How long one message gets before the session is stopped, in minutes."
          >
            <Input
              type="number"
              aria-label="Give up after, in minutes"
              min={POLICY_BOUNDS.defaultTimeoutMs.min / MS_PER_MINUTE}
              max={POLICY_BOUNDS.defaultTimeoutMs.max / MS_PER_MINUTE}
              value={draftMinutes ?? String(persisted.defaultTimeoutMs / MS_PER_MINUTE)}
              onChange={(e) => setDraftMinutes(e.target.value)}
              onBlur={(e) => {
                commit('defaultTimeoutMs', Number(e.target.value) * MS_PER_MINUTE);
                setDraftMinutes(null);
              }}
              className="w-24"
            />
          </SettingRow>
        </FieldCardContent>
      </FieldCard>
    </section>
  );
}
