/**
 * Rooms settings — how far agents may carry a conversation on their own, and
 * how many conversations one agent may work in at once (DOR-2104).
 *
 * The four numbers behind the cascade guard and the turn budget, offered for the
 * first time (DOR-1430). Before this panel they were reachable only by editing
 * `~/.dork/config.json`, which is why the migration that raised them could not
 * tell "left at 3 on purpose" from "never touched": there was nowhere to touch
 * them. This is that remedy.
 *
 * @module features/settings/ui/tabs/RoomsTab
 */
import {
  MAX_CONCURRENT_TURNS_PER_AGENT_BOUNDS,
  MAX_CONCURRENT_TURNS_PER_AGENT_DEFAULT,
  MAX_TOTAL_TURNS_PER_HOUR_BOUNDS,
  ROOM_TURN_LIMIT_BOUNDS,
  ROOM_TURN_LIMIT_DEFAULTS,
} from '@dorkos/shared/config-schema';
import { useRoomTurnLimits, type RoomTurnLimits } from '@/layers/entities/config';
import {
  BoundedNumberInput,
  FieldCard,
  FieldCardContent,
  InfoTip,
  MoreDetails,
  SettingRow,
  Skeleton,
  SwitchSettingRow,
} from '@/layers/shared/ui';

/** One of the four numbers, and how to say what it does. */
interface LimitField {
  /** Which setting this row writes. */
  key: Exclude<keyof RoomTurnLimits, 'turnLimitsEnabled'>;
  /** The row's label. */
  label: string;
  /** What the number does, in one short sentence ending with its default. */
  description: string;
  /** The rest of what a person may want to know, behind an info tip. */
  details: readonly string[];
  /** Lowest value the schema accepts. */
  min: number;
  /** Highest value the schema accepts. */
  max: number;
}

/**
 * The four numbers, in the order a person meets them: one conversation, one
 * agent inside it, one room's hour, then every room's hour.
 *
 * Bounds and defaults come from the schema rather than being written again
 * here. A hand-copied ceiling is a field that offers a number the server would
 * refuse, and a hand-copied default is a sentence that goes quietly stale.
 */
const LIMIT_FIELDS: readonly LimitField[] = [
  {
    key: 'maxAgentDepth',
    label: 'Replies in a row',
    description: `Agents pause after this many replies in a row. Default: ${ROOM_TURN_LIMIT_DEFAULTS.maxAgentDepth}.`,
    details: ['Your next message starts the count over.', 'Set it to 0 to stop automatic replies.'],
    min: ROOM_TURN_LIMIT_BOUNDS.maxAgentDepth.min,
    max: ROOM_TURN_LIMIT_BOUNDS.maxAgentDepth.max,
  },
  {
    key: 'maxTurnsPerAgentPerCascade',
    label: 'Replies from one agent',
    description: `Most turns one agent takes in one back-and-forth. Default: ${ROOM_TURN_LIMIT_DEFAULTS.maxTurnsPerAgentPerCascade}.`,
    details: ['Progress notes an agent posts while it works don’t count extra.'],
    min: ROOM_TURN_LIMIT_BOUNDS.maxTurnsPerAgentPerCascade.min,
    max: ROOM_TURN_LIMIT_BOUNDS.maxTurnsPerAgentPerCascade.max,
  },
  {
    key: 'maxAutomaticTurnsPerRoomPerHour',
    label: 'Replies in one room each hour',
    description: `Most automatic replies one room runs in an hour. Default: ${ROOM_TURN_LIMIT_DEFAULTS.maxAutomaticTurnsPerRoomPerHour}.`,
    details: ['It keeps one busy room from using up the whole allowance below.'],
    min: ROOM_TURN_LIMIT_BOUNDS.maxAutoTurnsPerHour.min,
    max: ROOM_TURN_LIMIT_BOUNDS.maxAutoTurnsPerHour.max,
  },
  {
    key: 'maxAutomaticTurnsTotalPerHour',
    label: 'Replies everywhere each hour',
    description: `Most automatic replies across all rooms in an hour. Default: ${ROOM_TURN_LIMIT_DEFAULTS.maxAutomaticTurnsTotalPerHour}.`,
    details: ['This caps what automatic replies can cost you.', 'No room can set its own.'],
    min: MAX_TOTAL_TURNS_PER_HOUR_BOUNDS.min,
    max: MAX_TOTAL_TURNS_PER_HOUR_BOUNDS.max,
  },
];

/** The label on the conversations-at-once field, and its accessible name. */
const CONCURRENCY_LABEL = 'Conversations at once';

/**
 * How far agents may carry a conversation without you, and how many
 * conversations one agent may work in at the same time.
 *
 * **The numbers stay on screen when the switch goes off.** They are disabled,
 * not cleared and not hidden: turning the limits off is a temporary posture, and
 * a panel that forgot what was set would make turning them back on a
 * re-typing job. The server keeps them for the same reason.
 */
export function RoomsTab() {
  const { limits, unsupported, loadError, maxConcurrentTurnsPerAgent, setLimits } =
    useRoomTurnLimits();

  return (
    <div className="space-y-6">
      {/* No heading: the Settings dialog draws the panel's own header. */}
      <div className="space-y-1">
        <p className="text-muted-foreground text-xs">
          How far agents reply to each other, and how many conversations each runs.
        </p>
        <MoreDetails className="text-xs">
          <p>Every message you send starts the reply counts over.</p>
          <p>A room can have limits of its own, in the panel beside it.</p>
        </MoreDetails>
      </div>

      {limits === null ? (
        <FieldCard>
          <FieldCardContent>
            {/* Three answers, and only one of them is a loading shape. A read
                that failed and a server that has no such settings are both
                FINISHED — showing either as "still loading" is a panel that
                waits forever and never says why. */}
            {loadError !== null ? (
              <p className="text-muted-foreground text-sm">
                Couldn’t load these settings. Close Settings and open it again.
              </p>
            ) : unsupported ? (
              <p className="text-muted-foreground text-sm">
                This version of DorkOS doesn’t have these settings. Update to change them.
              </p>
            ) : (
              // Never the shipped defaults while the read is in flight: these
              // are numbers a person may have changed, and printing ours would
              // state something false about their install and then correct
              // itself.
              [0, 1, 2, 3, 4].map((row) => (
                <div key={row} className="flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-full max-w-xs" />
                  </div>
                  <Skeleton className="h-9 w-24" />
                </div>
              ))
            )}
          </FieldCardContent>
        </FieldCard>
      ) : (
        <FieldCard>
          <FieldCardContent>
            <SwitchSettingRow
              label="Limit automatic replies"
              // Off says its consequence plainly, in place of the "on" line: a
              // real choice with a real consequence, not an alert to dismiss.
              // The Control Center's switch uses the same sentence, word for word.
              description={
                limits.turnLimitsEnabled
                  ? 'Agents pause when they reach a limit below.'
                  : 'Agents reply to each other without limit until you press Stop.'
              }
              checked={limits.turnLimitsEnabled}
              onCheckedChange={(on) => setLimits({ turnLimitsEnabled: on })}
            />

            {/* Vertical, per `SettingRow`'s own guidance for number inputs, and
                because these descriptions are two sentences long: side by side
                with a field they squeeze into a column three words wide on a
                phone.

                Nothing here is disabled WHILE SAVING. The write is optimistic,
                so the value on screen is already the new one — and disabling a
                field the cursor is in takes the keyboard out of it on every
                save, which is how a person typing the second of two numbers
                loses their place. */}
            {LIMIT_FIELDS.map((field) => (
              <SettingRow
                key={field.key}
                orientation="vertical"
                label={field.label}
                description={
                  <>
                    {field.description}{' '}
                    <InfoTip label={`About ${field.label.toLowerCase()}`}>
                      {field.details.map((line) => (
                        <p key={line}>{line}</p>
                      ))}
                    </InfoTip>
                  </>
                }
              >
                <BoundedNumberInput
                  aria-label={field.label}
                  value={limits[field.key]}
                  min={field.min}
                  max={field.max}
                  disabled={!limits.turnLimitsEnabled}
                  onCommit={(next) => setLimits({ [field.key]: next })}
                />
              </SettingRow>
            ))}
          </FieldCardContent>
        </FieldCard>
      )}

      {/* Its own card, and never disabled by the switch above: the switch is
          about agents answering each other, and this applies to every turn an
          agent takes — yours included. Shown only once the server has said
          what it is, for the same reason the limits wait for their read. A
          change binds the very next message; nothing already running stops. */}
      {limits !== null && maxConcurrentTurnsPerAgent !== null && (
        <FieldCard>
          <FieldCardContent>
            <SettingRow
              orientation="vertical"
              label={CONCURRENCY_LABEL}
              description={
                <>
                  {`How many conversations one agent works in at once. Default: ${MAX_CONCURRENT_TURNS_PER_AGENT_DEFAULT}.`}{' '}
                  <InfoTip label="About conversations at once">
                    <p>Higher is faster, but turns that change the same files can collide.</p>
                  </InfoTip>
                </>
              }
            >
              <BoundedNumberInput
                aria-label={CONCURRENCY_LABEL}
                value={maxConcurrentTurnsPerAgent}
                min={MAX_CONCURRENT_TURNS_PER_AGENT_BOUNDS.min}
                max={MAX_CONCURRENT_TURNS_PER_AGENT_BOUNDS.max}
                onCommit={(next) => setLimits({ maxConcurrentTurnsPerAgent: next })}
              />
            </SettingRow>
          </FieldCardContent>
        </FieldCard>
      )}
    </div>
  );
}
