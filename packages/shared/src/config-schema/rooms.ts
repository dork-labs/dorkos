/**
 * Room turn-limit bounds and defaults, and the `rooms` section of `UserConfigSchema`.
 *
 * Split out of `config-schema.ts`, which composes `UserConfigSchema` and
 * re-exports every public name from here. Plain Zod, no OpenAPI.
 *
 * @module shared/config-schema/rooms
 */
import { z } from 'zod';
import { ROOM_REPO_CAP_DEFAULTS } from '../room-repo.js';

/**
 * The bounds every room turn limit must satisfy, wherever it is set.
 *
 * **One definition because there are two writers.** These numbers can be set
 * install-wide in `rooms.*` below, and per room through
 * `PATCH /api/rooms/:id` (DOR-1429), and a per-room override that accepted a
 * value the install-wide field refuses would be a way round the ceiling by the
 * back door. Two copies of a bound is one copy too many: this object is what
 * both schemas build their `.min()`/`.max()` from, so the two cannot drift.
 *
 * `rooms.maxAutomaticTurnsTotalPerHour` is deliberately absent. It bounds the
 * whole install rather than a room, has no per-room meaning and no per-room
 * column, so it has exactly one writer and needs no shared bound.
 */
export const ROOM_TURN_LIMIT_BOUNDS = {
  /** How many automatic replies one chain may run. */
  maxAgentDepth: { min: 0, max: 100 },
  /** How many TURNS any ONE agent may take inside one chain. */
  maxTurnsPerAgentPerCascade: { min: 1, max: 100 },
  /** How many automatic replies one room may run in an hour. */
  maxAutoTurnsPerHour: { min: 0, max: 10_000 },
} as const;

/**
 * The bound on the one turn limit no room may override:
 * `rooms.maxAutomaticTurnsTotalPerHour`.
 *
 * Its own constant rather than a fourth key in {@link ROOM_TURN_LIMIT_BOUNDS},
 * because that object's contract is "what a per-room override must satisfy" and
 * this number has no per-room form. It is exported for the same reason the
 * others are: Settings offers all four numbers in one panel and must not
 * re-declare a ceiling the schema would refuse.
 */
export const MAX_TOTAL_TURNS_PER_HOUR_BOUNDS = { min: 0, max: 100_000 } as const;

/**
 * What the `rooms.*` turn limits are before anybody changes them.
 *
 * The schema below builds its `.default()` calls from this object, so the
 * shipped value has one definition. Settings reads the same object to tell a
 * person what the default IS while showing them the number they set instead
 * (DOR-1430) — a sentence that would otherwise be a hand-copied constant
 * quietly going stale next to the schema it describes.
 */
export const ROOM_TURN_LIMIT_DEFAULTS = {
  turnLimitsEnabled: true,
  maxAgentDepth: 30,
  maxTurnsPerAgentPerCascade: 10,
  maxAutomaticTurnsPerRoomPerHour: 1000,
  maxAutomaticTurnsTotalPerHour: 5000,
} as const;

/**
 * The bounds `rooms.maxConcurrentTurnsPerAgent` must satisfy — how many
 * conversations one agent may work in at the same time.
 *
 * Exported so Settings offers exactly the range the schema accepts. Eight is
 * the ceiling because DOR-500 measured real damage at six writers on one tree:
 * a person may go past that on purpose, but not by an order of magnitude.
 */
export const MAX_CONCURRENT_TURNS_PER_AGENT_BOUNDS = { min: 1, max: 8 } as const;

/**
 * What `rooms.maxConcurrentTurnsPerAgent` is before anybody changes it.
 *
 * The schema builds both of its declarations from this — the per-field
 * `.default()` and the `rooms` section literal — so a fresh install and an
 * upgraded one cannot disagree, and Settings reads it to say what the default
 * is.
 */
export const MAX_CONCURRENT_TURNS_PER_AGENT_DEFAULT = 3;

/** The `rooms` section of `UserConfigSchema`; its documentation sits on the field there. */
export const RoomsConfigSchema = z
  .object({
    /**
     * Whether automatic replies are limited at all.
     *
     * On is how it ships, and on is what every other number in this block
     * assumes. Turning it off means agents may answer each other as long as
     * they keep finding something to say: no reply limit, no per-agent limit,
     * no hourly ceiling. **The Stop button becomes the only brake, and it is
     * the only one** — nothing else in DorkOS will end a conversation two
     * agents are happy to carry on having, and every turn of it costs money.
     *
     * Off is a deliberate, temporary posture — watching two agents work
     * something out without the room stepping in. The numbers you set are
     * kept while it is off, so turning it back on restores exactly what you
     * had.
     */
    turnLimitsEnabled: z.boolean().default(ROOM_TURN_LIMIT_DEFAULTS.turnLimitsEnabled),
    /**
     * How many replies in a row agents may send each other before the room
     * stops them (ADR 260726-170127). Your own messages always start the
     * count over, so a room the limit has quietened is one message away from
     * running again. `0` turns automatic replies off entirely.
     */
    maxAgentDepth: z
      .number()
      .int()
      .min(ROOM_TURN_LIMIT_BOUNDS.maxAgentDepth.min)
      .max(ROOM_TURN_LIMIT_BOUNDS.maxAgentDepth.max)
      .default(ROOM_TURN_LIMIT_DEFAULTS.maxAgentDepth),
    /**
     * How many of those replies any ONE agent may run inside a single
     * back-and-forth.
     *
     * The limit above counts the whole chain however many agents are in it;
     * this one counts each agent separately, so a pair trading answers stops
     * after ten each rather than running the chain out between them. Your own
     * messages start both counts over.
     *
     * It counts TURNS, not messages. One turn may say several things — an
     * agent often posts a note or two about what it is doing before it
     * answers — and the whole lot spends one. Posts DorkOS cannot tie to a
     * turn, which means anything written before this was measured this way,
     * count one each.
     */
    maxTurnsPerAgentPerCascade: z
      .number()
      .int()
      .min(ROOM_TURN_LIMIT_BOUNDS.maxTurnsPerAgentPerCascade.min)
      .max(ROOM_TURN_LIMIT_BOUNDS.maxTurnsPerAgentPerCascade.max)
      .default(ROOM_TURN_LIMIT_DEFAULTS.maxTurnsPerAgentPerCascade),
    /**
     * The most automatic replies any ONE room may run in an hour, counted
     * whoever asked for them.
     *
     * The reply limit above bounds one conversation and reads who is writing
     * to do it. With **Require login** off — the default — DorkOS cannot tell
     * a program on your machine from you, so that reading can be sidestepped.
     * This one cannot: it counts every automatic reply a room runs and stops
     * at the number, whoever the message appeared to come from.
     *
     * It bounds a ROOM, not your bill — rooms are free to create, so this
     * alone can be multiplied by making more of them. `maxAutomaticTurnsTotalPerHour`
     * is the one that bounds the total. This one keeps a single busy room from
     * eating that whole allowance.
     */
    maxAutomaticTurnsPerRoomPerHour: z
      .number()
      .int()
      .min(ROOM_TURN_LIMIT_BOUNDS.maxAutoTurnsPerHour.min)
      .max(ROOM_TURN_LIMIT_BOUNDS.maxAutoTurnsPerHour.max)
      .default(ROOM_TURN_LIMIT_DEFAULTS.maxAutomaticTurnsPerRoomPerHour),
    /**
     * The most automatic replies this DorkOS may run in an hour, across every
     * room that exists.
     *
     * This is the ceiling on what automatic replies can cost you. It does not
     * care how many rooms or threads exist, or who the messages appeared to
     * come from. `0` stops automatic replies entirely.
     */
    maxAutomaticTurnsTotalPerHour: z
      .number()
      .int()
      .min(MAX_TOTAL_TURNS_PER_HOUR_BOUNDS.min)
      .max(MAX_TOTAL_TURNS_PER_HOUR_BOUNDS.max)
      .default(ROOM_TURN_LIMIT_DEFAULTS.maxAutomaticTurnsTotalPerHour),
    /**
     * How long a room waits for an agent's answer before it carries on
     * without it.
     *
     * The agent is NOT stopped. It keeps working, and its answer is posted
     * when it lands, saying which message it answers and how late it is. This
     * only decides how long the room holds its breath.
     *
     * Like every number in this area, this one is a judgement rather than a
     * measurement — see `meta/agent-etiquette.md` §9. Tune it to how long your
     * agents actually take.
     */
    replyWaitMinutes: z.number().int().min(1).max(120).default(10),
    /**
     * When a room gives up on a turn altogether and says the agent could not
     * answer.
     *
     * Counted from the same moment as `replyWaitMinutes` and always longer
     * than it: the wait is when the room stops waiting, this is when it stops
     * listening. Reaching it means an agent that kept producing output and
     * never finished, which is a fault worth reporting rather than waiting on
     * forever. Also a judgement, not a measurement (`meta/agent-etiquette.md`
     * §9).
     */
    lateReplyCeilingMinutes: z.number().int().min(1).max(1440).default(60),
    /**
     * How long an agent stays addressable after you talk to it, before it goes
     * back to needing an @mention. The clock starts at whichever came last in
     * that place: the agent's own message, or your @mention of it (DOR-2823).
     * Talking to it again starts the clock over.
     *
     * This is the ceiling, not the setting: a room can hold an agent to a
     * shorter window, never a longer one. `0` means an agent is only ever
     * addressable by @mention, whatever any room says.
     *
     * Like every number in this area, it is a judgement rather than a
     * measurement — see `meta/agent-etiquette.md` §9. Nobody publishes a
     * defensible figure for how long a person expects to keep talking to
     * something without naming it again, so this one is ours, to be tuned by
     * using the product. Raised from 10 to 60 by DOR-2823, after a person's
     * replies kept arriving just after a long agent turn used the window up.
     *
     * Agents talking to each other are held to the old 10 minutes and 5
     * messages whatever this says (`engagement.ts` `AGENT_POST_WINDOW`).
     */
    engagedWindowMinutes: z.number().int().min(0).max(1440).default(60),
    /**
     * How many messages from other people can go by before an agent stops
     * treating itself as part of the conversation. Counted, like the minutes,
     * from whichever came last in that place: the agent's own message, or
     * your @mention of it (DOR-2823). Raised from 5 to 15 by DOR-2823.
     *
     * The second half of the same window, and it ends on whichever runs out
     * first — a quiet ten minutes and a busy ten messages are both reasons to
     * stop assuming a question was meant for you. Also a ceiling, and also a
     * judgement rather than a measurement.
     */
    engagedWindowPosts: z.number().int().min(0).max(100).default(15),
    /**
     * How long an agent waits for the room to stop talking before it answers,
     * in milliseconds.
     *
     * When several people say things at once, the messages are gathered up and
     * answered together — one considered reply instead of one rushed reply per
     * message. This is how long "at once" means. Nothing is dropped: a message
     * that arrives after the pause simply starts the next answer.
     *
     * Like every number in this area, it is a judgement rather than a
     * measurement — see `meta/agent-etiquette.md` §9.
     */
    collectDebounceMs: z.number().int().min(0).max(10_000).default(500),
    /**
     * The most messages one gathered-up answer covers.
     *
     * Reaching it answers straight away instead of waiting out the pause, so a
     * room that never goes quiet still gets replies. The messages past it are
     * not lost — they start the next answer.
     */
    collectMaxEntries: z.number().int().min(1).max(200).default(20),
    /**
     * Whether an agent may skip messages that were clearly meant for somebody
     * else, instead of reading each one properly before deciding to say
     * nothing.
     *
     * Agents in a channel keep listening for a while after you talk to them,
     * so they can follow the conversation without being named every time. The
     * cost of that is real: today an agent thinks about every message it
     * overhears, even one that starts with somebody else's name. Listening
     * should be close to free.
     *
     * - `routing` — skip a message that named a different agent, and skip the
     *   replies in an exchange this agent is not part of. Nothing else. This
     *   is the default.
     * - `off` — think about every overheard message, as before.
     *
     * A skipped message is not lost: the agent still sees it as background the
     * next time it does reply. And nothing here touches a message that names
     * the agent, or anything said in a direct message — those always get an
     * answer.
     */
    responseGate: z.enum(['off', 'routing']).default('routing'),
    /**
     * How many conversations one agent may work in at the same time.
     *
     * An agent's rooms and chats all run in its own folder, so two turns at
     * once are two writers in one set of files — the contention ADR
     * `260726-170125` (DOR-500) measured, where six writers on one tree
     * clobbered each other and halving them roughly doubled what survived.
     * A message that finds the agent at this limit is held, never refused,
     * and starts the moment one of its turns ends (ADR `260818-234541`).
     *
     * Three covers the common case — one person talking to one agent in two
     * or three rooms — well short of the measured collision regime; `1` is
     * the old one-turn-at-a-time behaviour. It never lets one agent run two
     * turns in the SAME room: a room is one transcript, and that ceiling is
     * not a setting.
     *
     * Read at every claim decision, so a change binds the very next message.
     * Lowering it while turns are running stops nothing already started; new
     * turns wait until the agent is back under the limit.
     *
     * Both declarations of this value — here and in the `rooms` section
     * literal below — read {@link MAX_CONCURRENT_TURNS_PER_AGENT_DEFAULT}, so
     * they cannot disagree.
     */
    maxConcurrentTurnsPerAgent: z
      .number()
      .int()
      .min(MAX_CONCURRENT_TURNS_PER_AGENT_BOUNDS.min)
      .max(MAX_CONCURRENT_TURNS_PER_AGENT_BOUNDS.max)
      .default(MAX_CONCURRENT_TURNS_PER_AGENT_DEFAULT),
    /**
     * A room's own files — its git repo, the standing worktree each agent
     * works in, and the merges that bring that work back (spec
     * `project-rooms`).
     *
     * Nothing here reaches a room that has no repo, and a room only gets one
     * when you give it one. Every declaration of these values has to agree,
     * here and in the section literal below, because `conf` merges top-level
     * defaults shallowly.
     */
    repo: z
      .object({
        /**
         * Whether a room may have files at all.
         *
         * On is how it ships. Turning it off makes every room behave like a
         * room without files: no new repo can be created, and a room that
         * already has one stops offering it. Nothing on disk is deleted, so
         * turning it back on returns everything.
         */
        enabled: z.boolean().default(true),
        /**
         * How many days an agent's working copy may sit untouched before
         * DorkOS tidies it away.
         *
         * **Only a working copy with nothing in it is ever removed.** One
         * holding unsaved edits, or work that has not been merged back into
         * the room, is left alone however long it sits there and is shown to
         * you instead — and so is one the agent is working in right now. So
         * this number decides when clutter goes, never when work does.
         */
        worktreeReapDays: z.number().int().min(1).max(365).default(14),
        /**
         * The largest single file an agent may merge into the room, in bytes.
         *
         * A merge carrying something bigger is refused whole and says which
         * file it was. Big files belong in the room's attachments, which is
         * what they are for.
         */
        maxFileBytes: z.number().int().positive().default(ROOM_REPO_CAP_DEFAULTS.maxFileBytes),
        /** How large one room's files may grow in total, in bytes. */
        maxRepoBytes: z.number().int().positive().default(ROOM_REPO_CAP_DEFAULTS.maxRepoBytes),
        /**
         * How much of a room's `ROOM.md` reaches its agents, in bytes.
         *
         * The room's conventions ride along with every turn, so a long one
         * costs money on every message. Past this size the agents are told
         * the file is too long to send instead of being sent part of it —
         * half a rule reads like a whole one.
         */
        maxRoomMdBytes: z.number().int().positive().default(ROOM_REPO_CAP_DEFAULTS.maxRoomMdBytes),
        /**
         * How long a merge waits its turn before giving up, in milliseconds.
         *
         * Merges into a room run one at a time, so two agents finishing
         * together queue rather than collide. This is how long the one behind
         * waits — long enough for an ordinary merge ahead of it, short enough
         * that an agent is not left hanging.
         */
        mergeQueueWaitMs: z.number().int().min(1000).max(600_000).default(30_000),
      })
      .default(() => ({
        enabled: true,
        worktreeReapDays: 14,
        maxFileBytes: ROOM_REPO_CAP_DEFAULTS.maxFileBytes,
        maxRepoBytes: ROOM_REPO_CAP_DEFAULTS.maxRepoBytes,
        maxRoomMdBytes: ROOM_REPO_CAP_DEFAULTS.maxRoomMdBytes,
        mergeQueueWaitMs: 30_000,
      })),
  })
  .default(() => ({
    turnLimitsEnabled: true,
    maxAgentDepth: 30,
    maxTurnsPerAgentPerCascade: 10,
    maxAutomaticTurnsPerRoomPerHour: 1000,
    maxAutomaticTurnsTotalPerHour: 5000,
    replyWaitMinutes: 10,
    lateReplyCeilingMinutes: 60,
    engagedWindowMinutes: 60,
    engagedWindowPosts: 15,
    collectDebounceMs: 500,
    collectMaxEntries: 20,
    responseGate: 'routing' as const,
    // How many conversations one agent may work in at once. Two declarations
    // carry this value — the per-field one above and this — and both have to
    // agree or the shallow defaults-merge lands somebody on the other value.
    maxConcurrentTurnsPerAgent: MAX_CONCURRENT_TURNS_PER_AGENT_DEFAULT,
    repo: {
      enabled: true,
      worktreeReapDays: 14,
      maxFileBytes: ROOM_REPO_CAP_DEFAULTS.maxFileBytes,
      maxRepoBytes: ROOM_REPO_CAP_DEFAULTS.maxRepoBytes,
      maxRoomMdBytes: ROOM_REPO_CAP_DEFAULTS.maxRoomMdBytes,
      mergeQueueWaitMs: 30_000,
    },
  }));
