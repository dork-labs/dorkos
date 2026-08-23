/**
 * Rooms settings — how far agents may carry a conversation on their own.
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
  MAX_TOTAL_TURNS_PER_HOUR_BOUNDS,
  ROOM_TURN_LIMIT_BOUNDS,
  ROOM_TURN_LIMIT_DEFAULTS,
} from '@dorkos/shared/config-schema';
import { useRoomTurnLimits, type RoomTurnLimits } from '@/layers/entities/config';
import {
  BoundedNumberInput,
  FieldCard,
  FieldCardContent,
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
  /** What the number does, in one or two short sentences. */
  description: string;
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
    description: `How many replies in a row agents may trade before the room pauses them. Your next message starts the count over. Set it to 0 to stop automatic replies entirely. Default: ${ROOM_TURN_LIMIT_DEFAULTS.maxAgentDepth}.`,
    min: ROOM_TURN_LIMIT_BOUNDS.maxAgentDepth.min,
    max: ROOM_TURN_LIMIT_BOUNDS.maxAgentDepth.max,
  },
  {
    key: 'maxTurnsPerAgentPerCascade',
    label: 'Replies from one agent',
    description: `How many of those replies one agent may send in a single back-and-forth, counted as messages posted. An agent that thinks out loud spends this faster than one that answers once. Default: ${ROOM_TURN_LIMIT_DEFAULTS.maxTurnsPerAgentPerCascade}.`,
    min: ROOM_TURN_LIMIT_BOUNDS.maxTurnsPerAgentPerCascade.min,
    max: ROOM_TURN_LIMIT_BOUNDS.maxTurnsPerAgentPerCascade.max,
  },
  {
    key: 'maxAutomaticTurnsPerRoomPerHour',
    label: 'Replies in one room each hour',
    description: `The most automatic replies any one room may run in an hour. It keeps a single busy room from using up the whole allowance below. Default: ${ROOM_TURN_LIMIT_DEFAULTS.maxAutomaticTurnsPerRoomPerHour}.`,
    min: ROOM_TURN_LIMIT_BOUNDS.maxAutoTurnsPerHour.min,
    max: ROOM_TURN_LIMIT_BOUNDS.maxAutoTurnsPerHour.max,
  },
  {
    key: 'maxAutomaticTurnsTotalPerHour',
    label: 'Replies everywhere each hour',
    description: `The most automatic replies all your rooms may run in an hour together. This is the ceiling on what automatic replies can cost you, and no room may set its own. Default: ${ROOM_TURN_LIMIT_DEFAULTS.maxAutomaticTurnsTotalPerHour}.`,
    min: MAX_TOTAL_TURNS_PER_HOUR_BOUNDS.min,
    max: MAX_TOTAL_TURNS_PER_HOUR_BOUNDS.max,
  },
];

/**
 * How far agents may carry a conversation without you.
 *
 * **The numbers stay on screen when the switch goes off.** They are disabled,
 * not cleared and not hidden: turning the limits off is a temporary posture, and
 * a panel that forgot what was set would make turning them back on a
 * re-typing job. The server keeps them for the same reason.
 */
export function RoomsTab() {
  const { limits, unsupported, loadError, setLimits } = useRoomTurnLimits();

  return (
    <div className="space-y-6">
      {/* No heading: the Settings dialog draws the panel's own header. */}
      <p className="text-muted-foreground text-xs">
        Agents in a room can answer each other without being asked. These limits decide how far that
        goes before the room steps in, and every message you send starts the counts over. A single
        room can be given limits of its own, in the panel beside it.
      </p>

      {limits === null ? (
        <FieldCard>
          <FieldCardContent>
            {/* Three answers, and only one of them is a loading shape. A read
                that failed and a server that has no such settings are both
                FINISHED — showing either as "still loading" is a panel that
                waits forever and never says why. */}
            {loadError !== null ? (
              <p className="text-muted-foreground text-sm">
                Your settings could not be read just now. Close Settings and open it again to try
                once more.
              </p>
            ) : unsupported ? (
              <p className="text-muted-foreground text-sm">
                This server doesn&apos;t report these settings yet. Update DorkOS to change them
                here.
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
              description="Keep the limits below on."
              checked={limits.turnLimitsEnabled}
              onCheckedChange={(on) => setLimits({ turnLimitsEnabled: on })}
            />

            {/* Said only when it is true, and said plainly. Turning this off is
                a real choice with a real consequence, and the consequence is one
                sentence — not an alert somebody has to dismiss to get on with
                what they already decided to do. */}
            {!limits.turnLimitsEnabled && (
              <p className="text-muted-foreground text-xs">
                Agents can reply to each other without limit. The Stop button is the only brake.
              </p>
            )}

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
                description={field.description}
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
    </div>
  );
}
