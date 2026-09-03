import { useQueryClient } from '@tanstack/react-query';
import {
  BoundedNumberInput,
  FieldCard,
  FieldCardContent,
  SettingRow,
  SwitchSettingRow,
} from '@/layers/shared/ui';
import {
  configKeys,
  useConfig,
  useRoomTurnLimits,
  useUpdateConfig,
} from '@/layers/entities/config';
import { OpenMeshSwitch } from '@/layers/entities/mesh';
import { RemoteAccessRow } from './RemoteAccessRow';

/** Lowest and highest concurrent-run counts the scheduler schema accepts. */
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 10;
/**
 * The scheduler's shipped default (`scheduler.maxConcurrentRuns`), used as the
 * pre-load fallback so the stepper shows the real default — not `1` — in the
 * frame before config resolves.
 */
const DEFAULT_CONCURRENCY = 4;

/**
 * The Control Center's power switches, all writing through hooks that already
 * exist (spec `full-power-defaults`, D7):
 *
 * - **Remote access** — first, because it is the only switch here that changes
 *   who can reach this machine rather than how agents behave on it (DOR-1743).
 *   It reads the shared tunnel model, so it and the Remote Access dialog cannot
 *   disagree.
 * - **Open mesh** — the shared {@link OpenMeshSwitch}, wired to the topology
 *   query, so it reads the real `openMesh` rule rather than a local boolean.
 * - **Limit automatic replies** — `rooms.turnLimitsEnabled`, through the same
 *   {@link useRoomTurnLimits} hook Settings → Rooms writes with, so the two
 *   surfaces cannot disagree. The four numbers behind it stay in Settings: this
 *   panel is for the switches a person reaches for, not for tuning.
 * - **Standing grants** — `approvals.standingGrants`, coupled to Require login
 *   exactly as the canonical Security control is: without a login DorkOS cannot
 *   tell the operator from an agent, so the switch reads off and is held.
 * - **Warm agents** — `runtimes.claudeCode.persistentSession`. This is the new
 *   home of the switch that left Settings → Experiments when the flag graduated;
 *   its honest cost note travels with it.
 * - **Schedule concurrency** — `scheduler.maxConcurrentRuns`, a bounded stepper
 *   honouring the schema's 1–10 range.
 */
export function ControlCenterSwitches() {
  const { data: config } = useConfig();
  const updateConfig = useUpdateConfig();
  const queryClient = useQueryClient();
  const { limits, setLimits } = useRoomTurnLimits();

  // Every config reader — the status bar, the sidebar, `useFeatureEnabled` —
  // sits on a broader key set than this flyout, and the server applies each
  // change live, so a write invalidates the whole config prefix.
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: configKeys.all });

  const standingGrants = config?.approvals?.standingGrants ?? false;
  const loginEnabled = config?.auth?.enabled ?? false;
  // Warm agents default on (spec `full-power-defaults`); read from the config
  // route's `claudeCode` block, which exposes it now that its Experiments switch
  // is gone.
  const persistentSession = config?.claudeCode?.persistentSession ?? true;
  const maxConcurrentRuns = config?.scheduler?.maxConcurrentRuns ?? DEFAULT_CONCURRENCY;

  return (
    <FieldCard>
      <FieldCardContent>
        <RemoteAccessRow />

        <OpenMeshSwitch />

        {/* The off state says the consequence in the same words Settings → Rooms
            uses, because it is the same consequence and a person who read it
            there must not have to re-derive it here. Disabled until the limits
            land: `turnLimitsEnabled` ships on, so guessing would draw the right
            switch most of the time and let somebody flip a guess the rest. */}
        <SwitchSettingRow
          label="Limit automatic replies"
          description={
            limits?.turnLimitsEnabled === false
              ? 'Agents can reply to each other without limit. The Stop button is the only brake.'
              : 'Agents stop replying to each other once a back-and-forth has run far enough. Your next message starts the count over. Set the numbers in Settings → Rooms.'
          }
          checked={limits?.turnLimitsEnabled ?? true}
          disabled={limits === null}
          onCheckedChange={(next) => setLimits({ turnLimitsEnabled: next })}
        />

        <SwitchSettingRow
          label="Standing permissions"
          description={
            loginEnabled
              ? 'Answer “stop asking about this” once from an approval card and DorkOS remembers it — one agent, one action at a time.'
              : 'Turn on Require login in Settings → Access to use this. Without it, DorkOS cannot tell you apart from an agent on this machine.'
          }
          checked={standingGrants && loginEnabled}
          disabled={!loginEnabled || updateConfig.isPending}
          onCheckedChange={(next) =>
            updateConfig.mutate({ approvals: { standingGrants: next } }, { onSuccess: invalidate })
          }
        />

        <SwitchSettingRow
          label="Warm agents"
          description="Your agent stays running between messages, so replies start about 4× faster. Keeps up to about 1 GB of memory per warm agent, and at most twelve stay warm."
          checked={persistentSession}
          disabled={updateConfig.isPending}
          onCheckedChange={(next) =>
            updateConfig.mutate(
              { runtimes: { claudeCode: { persistentSession: next } } },
              { onSuccess: invalidate }
            )
          }
        />

        <SettingRow
          label="Scheduled runs at once"
          description="How many scheduled tasks may run at the same time."
        >
          <BoundedNumberInput
            value={maxConcurrentRuns}
            min={MIN_CONCURRENCY}
            max={MAX_CONCURRENCY}
            aria-label="Scheduled runs at once"
            onCommit={(value) =>
              updateConfig.mutate(
                { scheduler: { maxConcurrentRuns: value } },
                { onSuccess: invalidate }
              )
            }
          />
        </SettingRow>
      </FieldCardContent>
    </FieldCard>
  );
}
