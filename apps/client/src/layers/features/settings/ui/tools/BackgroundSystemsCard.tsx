/**
 * The two background systems a person can switch off, in the Settings Tools tab.
 *
 * These are NOT the tool-group switches above them, and the difference is worth
 * keeping straight. A tool-group switch decides whether agents are told a set of
 * tools exists; it changes what the next turn sees. These two decide whether
 * DorkOS runs the subsystem behind those tools at all, and DorkOS only starts
 * its subsystems once, at boot — so the change is real the moment it is saved
 * and visible the next time DorkOS starts. The row says exactly that rather than
 * implying an effect it has not had (spec team-room-home D6).
 *
 * Purely presentational: persistence is the parent's job, as with
 * {@link SchedulerSettings}.
 *
 * @module features/settings/ui/tools/BackgroundSystemsCard
 */
import { FieldCard, FieldCardContent, SwitchSettingRow } from '@/layers/shared/ui';

/** One background system's state, as the server reports it. */
export interface BackgroundSystemState {
  /** Whether the subsystem is running right now. */
  running: boolean;
  /** What the setting says. Falls back to {@link BackgroundSystemState.running} on an older server. */
  enabledInConfig?: boolean;
  /** Whether an environment variable decides this instead of the setting. */
  lockedByEnv?: boolean;
  /** Why the subsystem failed to start, when that is why it is not running. */
  initError?: string;
}

/**
 * Which position the switch should show.
 *
 * Normally the SETTING, because that is what the switch writes and a person must
 * see their own choice survive. The exception is a subsystem an environment
 * variable has taken over: there the setting is inert, so showing it would put
 * "on" over a machine where the thing is off. A locked switch reports reality.
 *
 * @param state - The subsystem's reported state.
 */
function switchPosition(state: BackgroundSystemState): boolean {
  if (state.lockedByEnv) return state.running;
  return state.enabledInConfig ?? state.running;
}

interface BackgroundSystemsCardProps {
  /** The Tasks scheduler, from `config.tasks`. */
  tasks: BackgroundSystemState;
  /** The Relay message bus, from `config.relay`. */
  relay: BackgroundSystemState;
  /** Persist `scheduler.enabled`. */
  onTasksChange: (enabled: boolean) => void;
  /** Persist `relay.enabled`. */
  onRelayChange: (enabled: boolean) => void;
}

/**
 * What a row says about itself, once the setting and reality are compared.
 *
 * @param state - The subsystem's reported state.
 * @param envVar - The environment variable that can overrule the setting.
 * @param base - The plain description of what the switch does.
 */
function describe(state: BackgroundSystemState, envVar: string, base: string): string {
  if (state.lockedByEnv) {
    return `${base} Right now ${envVar} on this machine decides it, so this switch cannot.`;
  }
  const setting = state.enabledInConfig ?? state.running;
  // A crash is checked BEFORE the pending comparison, because both look
  // identical from here: on in config, not running. Reading it as a pending
  // change would promise a restart fixes it and would also contradict the
  // failure warning already sitting on the tool-group row above.
  if (setting && !state.running && state.initError) {
    return `${base} It is on, but it failed to start when DorkOS last started, so nothing is running.`;
  }
  if (setting !== state.running) {
    return `${base} Saved. It takes effect the next time DorkOS starts.`;
  }
  return base;
}

/**
 * The background-systems card for the Settings Tools tab.
 *
 * Two switches, one per subsystem a person can turn off entirely.
 */
export function BackgroundSystemsCard({
  tasks,
  relay,
  onTasksChange,
  onRelayChange,
}: BackgroundSystemsCardProps) {
  return (
    <div className="space-y-4" data-testid="background-systems">
      <p className="text-muted-foreground text-sm">
        These two keep running when you are not looking. Turning one off stops DorkOS from starting
        it, and its tools go quiet with it. DorkOS starts them once, when it starts, so a change
        here waits for the next start.
      </p>
      <FieldCard>
        <FieldCardContent>
          <SwitchSettingRow
            label="Scheduled runs"
            description={describe(
              tasks,
              'DORKOS_TASKS_ENABLED',
              'Starts your scheduled work when it is due. Off means nothing runs on a schedule.'
            )}
            checked={switchPosition(tasks)}
            onCheckedChange={onTasksChange}
            disabled={tasks.lockedByEnv === true}
          />
          <SwitchSettingRow
            label="Agent messaging"
            description={describe(
              relay,
              'DORKOS_RELAY_ENABLED',
              'Carries messages between your agents, and to and from Telegram, Slack, and webhooks. Off means those stop.'
            )}
            checked={switchPosition(relay)}
            onCheckedChange={onRelayChange}
            disabled={relay.lockedByEnv === true}
          />
        </FieldCardContent>
      </FieldCard>
    </div>
  );
}
