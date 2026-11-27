import { z } from 'zod';

import { HttpsUrlSchema, IdSchema, TimestampSchema, tolerantEnum } from './primitives.js';

/**
 * The account directory: what one account has, across every DorkOS it uses.
 *
 * The account's own list of where it lives: the person's homes (their own
 * computers, and their DorkOS in the cloud) and devices, whether each is
 * reachable, whether each computer offers its own page, and the spaces the
 * person has joined, by name and address, and how it learned of them. It holds
 * no space data: no agents, chats, settings or inbox. A computer reports itself
 * only while its owner has the link and the report switch on at that computer.
 * The report names this computer, whether it is reachable, whether it offers
 * its own page, and the spaces its owner joined from it (name and address). It
 * holds nothing else of the computer. Each home serves its own agents to the
 * person's other homes over the session relay, so the same list of agents
 * shows everywhere with no copy here.
 *
 * Two rules hold for everything here:
 *
 * - **It is the account's own, and only the account's.** Nobody else ever
 *   sees it. Who may do what:
 *
 *   | Caller                                    | Read | Own report | Settings | Forget a space |
 *   | ----------------------------------------- | ---- | ---------- | -------- | -------------- |
 *   | the person's session                      | yes  | no         | yes      | yes            |
 *   | the person's hub, or a computer of theirs | yes  | yes        | yes      | yes            |
 *   | a cloud agent computer                    | no   | yes        | no       | no             |
 *
 *   An instance key acts for the person who linked the instance. An agent
 *   computer runs agent code and packages, so it may not read the directory.
 *   No instance reports agents: the app sends `agents: []`.
 *   An instance linked to an organization, and any refused call, gets
 *   `not_found`.
 * - **It remembers where things are, never how to get in.** No entry carries a
 *   transcript, a message, a sign-in or a credential for anything. A space
 *   entry is a name and an address; a computer entry is a name and whether it
 *   is on.
 */

/**
 * What kind of DorkOS an instance is.
 *
 * `computer` is a person's own machine, `hub` is their DorkOS in the cloud, and
 * `agent-computer` is a cloud agent computer.
 */
export const DirectoryInstanceRoleSchema = z
  .enum(['computer', 'hub', 'agent-computer'])
  .describe(
    'What kind of DorkOS an instance is: a person`s own, their cloud one, or an agent computer.'
  );

/** What kind of DorkOS an instance is. */
export type DirectoryInstanceRole = z.infer<typeof DirectoryInstanceRoleSchema>;

/**
 * Whether something reported recently enough to read as there.
 *
 * For a person's own computer, `available` reported within the service's
 * window, `offline` reported before it, and `unknown` never reported (an app
 * from before reports existed), which is never shown as offline.
 *
 * For a hub or a cloud agent computer, the service reads it from the machine's
 * state, not from reports: asleep but able to wake is `available`, and
 * `offline` means stopped for credits, a hold or a suspension, or failed. An
 * idle cloud agent is never shown as away.
 *
 * The service derives it either way; a client renders it rather than
 * recomputing it.
 */
export const DirectoryAvailabilitySchema = z
  .enum(['available', 'offline', 'unknown'])
  .describe('Whether something reported recently enough to read as there.');

/** Whether something reported recently enough to read as there. */
export type DirectoryAvailability = z.infer<typeof DirectoryAvailabilitySchema>;

/**
 * How far a person let the web reach one of their computers.
 *
 * `off` (not reachable from the web), `chat` (chats, messages and approvals,
 * through the hub), `full-control` (also the terminal, files and settings,
 * by moving to the computer's own remote address). Set only at the computer,
 * by its signed-in owner; this is the computer telling the account.
 *
 * In the directory it says only whether the computer offers its own page. The
 * app reports `chat` or `full-control` and nothing else
 * ({@link DirectoryReportReachSchema}); the rest of the level stays at the
 * computer. `off` stays here so a value that parsed before still parses.
 */
export const DirectoryReachLevelSchema = z
  .enum(['off', 'chat', 'full-control'])
  .describe('How far a person let the web reach a computer of theirs. Set only at the computer.');

/** How far a person let the web reach one of their computers. */
export type DirectoryReachLevel = z.infer<typeof DirectoryReachLevelSchema>;

/**
 * The `reach` the app puts in a report: whether the computer offers its own
 * page, and nothing more.
 *
 * `full-control` while the computer's owner has turned on full control at the
 * computer, else `chat`. A computer reports at all only while its link to the
 * web is on, so it never reports `off`.
 */
export const DirectoryReportReachSchema = z
  .enum(['chat', 'full-control'])
  .describe(
    'The reach the app reports: full-control while full control is on at the computer, else chat.'
  );

/** The `reach` the app puts in a report. */
export type DirectoryReportReach = z.infer<typeof DirectoryReportReachSchema>;

/**
 * How the account learned of a space.
 *
 * `service` (this service hosts it), `sign-in` (the person signed in to it with
 * "Continue with DorkOS"), `computer` (one of the person's computers reported
 * that it joined it).
 */
export const DirectorySpaceSourceSchema = z
  .enum(['service', 'sign-in', 'computer'])
  .describe('How the account learned of a space.');

/** How the account learned of a space. */
export type DirectorySpaceSource = z.infer<typeof DirectorySpaceSourceSchema>;

/** What the person is in a space. */
export const DirectorySpaceRoleSchema = z
  .enum(['owner', 'admin', 'member'])
  .describe('What the person is in a space.');

/** What the person is in a space. */
export type DirectorySpaceRole = z.infer<typeof DirectorySpaceRoleSchema>;

/** Whether a space is open or archived. */
export const DirectorySpaceStateSchema = z
  .enum(['active', 'archived'])
  .describe('Whether a space is open or archived.');

/** Whether a space is open or archived. */
export type DirectorySpaceState = z.infer<typeof DirectorySpaceStateSchema>;

/** The longest name a report may carry for an agent, a computer or a space. */
export const DIRECTORY_NAME_MAX_LENGTH = 200 as const;

/** The most agents one computer's report may name. */
export const DIRECTORY_REPORT_MAX_AGENTS = 1_000 as const;

/** The most spaces one computer's report may name. */
export const DIRECTORY_REPORT_MAX_SPACES = 500 as const;

const name = z.string().min(1).max(DIRECTORY_NAME_MAX_LENGTH);

/**
 * One agent, as the computer that runs it reported it.
 *
 * **The app sends none and reads none.** Every report it makes carries
 * `agents: []`, and it never reads this part: agents stay on each home, and
 * each home serves its own over the session relay. The shape stays so an
 * answer from the service still parses.
 */
export const DirectoryAgentSchema = z
  .object({
    agentId: IdSchema.describe(
      'The agent`s id on the computer that runs it. Unique within that computer, not across the account.'
    ),
    instanceId: IdSchema.describe(
      'Where the agent lives: the person`s computer that runs it, or for a cloud agent, the hub.'
    ),
    worksOn: IdSchema.nullable()
      .optional()
      .describe(
        'For a cloud agent, the cloud agent computer it works on (`CloudComputerSchema.id`). Null or absent for an agent on a person`s own computer.'
      ),
    name: z.string().describe('The agent`s name, as its computer last reported it.'),
    availability: tolerantEnum(DirectoryAvailabilitySchema).describe(
      'Whether its computer reported it recently. A value this release does not know reads as unrecognised.'
    ),
    lastSeenAt: TimestampSchema.nullable().describe(
      'When its computer last reported it, or null if one never has. "Away since" reads from this.'
    ),
  })
  .describe(
    'One agent, as the computer that runs it reported it. No history, no messages. The app sends none and reads none.'
  );

/** One agent, as the computer that runs it reported it. */
export type DirectoryAgent = z.infer<typeof DirectoryAgentSchema>;

/**
 * One DorkOS the account has: one of the person's homes and devices, whether
 * it is reachable, and, for a computer of theirs, whether it offers its own
 * page. The page's address is here only while it does.
 */
export const DirectoryInstanceSchema = z
  .object({
    instanceId: IdSchema,
    role: tolerantEnum(DirectoryInstanceRoleSchema).describe(
      'What kind of DorkOS it is. A value this release does not know reads as unrecognised.'
    ),
    displayName: z.string().describe('The name a person gave it.'),
    availability: tolerantEnum(DirectoryAvailabilitySchema),
    lastSeenAt: TimestampSchema.nullable(),
    reach: tolerantEnum(DirectoryReachLevelSchema)
      .nullable()
      .describe(
        'How far its owner let the web reach it, as it last reported. Null for a hub or an agent computer, and for a computer that never said.'
      ),
    remoteAddress: HttpsUrlSchema.nullable().describe(
      'The computer`s own managed remote address, where "full control" moves the page. Filled in by the service from the address it issued, never from a report. Null unless `reach` is full-control.'
    ),
  })
  .describe(
    'A home or device of the person`s, whether it is reachable, and whether a computer of theirs offers its own page.'
  );

/** One DorkOS the account has. */
export type DirectoryInstance = z.infer<typeof DirectoryInstanceSchema>;

/** One space the account belongs to. A name and an address, never a sign-in. */
export const DirectorySpaceSchema = z
  .object({
    spaceId: IdSchema.describe('The directory`s own id for this entry. Opaque.'),
    name: z
      .string()
      .describe(
        'The space`s name. A name from this service`s own servers wins over one from a sign-in, and a sign-in`s over one a computer reported.'
      ),
    address: HttpsUrlSchema.describe(
      'Where the space is, normalised: lower-case scheme and host, no default port, no trailing slash, no query or fragment. One entry per normalised address. Open it to join from this computer; joining still asks for the space`s own approval.'
    ),
    hostSpaceId: IdSchema.optional().describe(
      'The id the hosting server gives this space, when this service hosts it. Stays the same when the name or address changes.'
    ),
    role: tolerantEnum(DirectorySpaceRoleSchema)
      .nullable()
      .describe('What the person is in it, or null when only a computer reported it.'),
    state: tolerantEnum(DirectorySpaceStateSchema)
      .nullable()
      .describe('Whether it is open or archived, or null when only a computer reported it.'),
    sources: z
      .array(tolerantEnum(DirectorySpaceSourceSchema))
      .min(1)
      .describe('Every way the account learned of it.'),
    joinedBy: z
      .array(IdSchema)
      .describe(
        'The instances that reported joining it. A computer not listed has not joined; "Add to this computer" is offered there.'
      ),
    firstLearnedAt: TimestampSchema,
    lastConfirmedAt: TimestampSchema.describe('When any source last confirmed it.'),
  })
  .describe(
    'One space the account belongs to: its name and address, and how the account learned of it. Never a sign-in.'
  );

/** One space the account belongs to. */
export type DirectorySpace = z.infer<typeof DirectorySpaceSchema>;

/** A clock time as hours and minutes, `HH:MM`. */
export const ClockTimeSchema = z
  .string()
  .regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'must be HH:MM, hours from 00 to 23')
  .describe('A clock time, HH:MM, in the account`s time zone.');

/**
 * The account's settings in the directory.
 *
 * `learnSpacesFromSignIn` is an account setting, and the app reads and writes
 * it. **The app does not read or write `timeZone` or `quietHours`:** a
 * space's settings stay on its home, and working hours stay on the person's
 * computer. They stay in the shape so an answer from the service still parses.
 */
export const DirectorySettingsSchema = z
  .object({
    timeZone: z
      .string()
      .min(1)
      .max(64)
      .nullable()
      .describe(
        'An IANA time zone name, or null when the account has none yet. The app does not read or write it.'
      ),
    quietHours: z
      .object({
        start: ClockTimeSchema,
        end: ClockTimeSchema.describe(
          'May be earlier than `start`: quiet hours that cross midnight.'
        ),
      })
      .nullable()
      .describe(
        'When agents should not reach the person, or null for never quiet. The app does not read or write it.'
      ),
    learnSpacesFromSignIn: z
      .boolean()
      .describe(
        'Whether a "Continue with DorkOS" sign-in to a space adds it to the list. Its own switch, on by default.'
      ),
    updatedAt: TimestampSchema.nullable().describe(
      'When any of these last changed, or null if never.'
    ),
  })
  .describe(
    'How the account learns of spaces, and a time zone and quiet hours the app does not read or write.'
  );

/** The account's settings in the directory. */
export type DirectorySettings = z.infer<typeof DirectorySettingsSchema>;

/**
 * `GET /v1/directory` — the account directory.
 *
 * A person's session, or an instance key (for the person who linked the
 * instance; one linked to an organization gets `not_found`). An account with
 * nothing in it gets empty lists, never a 404.
 */
export const DirectorySchema = z
  .object({
    instances: z.array(DirectoryInstanceSchema),
    agents: z
      .array(DirectoryAgentSchema)
      .describe(
        'Agents the service holds from earlier reports. The app sends none and reads none.'
      ),
    spaces: z.array(DirectorySpaceSchema),
    settings: DirectorySettingsSchema,
    reportEverySeconds: z
      .number()
      .int()
      .positive()
      .describe('How often a computer should send its report while it is on.'),
  })
  .describe('What one account has, across every DorkOS it uses. Only the account`s own.');

/** What one account has, across every DorkOS it uses. */
export type Directory = z.infer<typeof DirectorySchema>;

/**
 * `PUT /v1/directory/instances/self` — this instance's report. Instance key
 * only.
 *
 * The report names this computer, whether it is reachable, whether it offers
 * its own page, and the spaces its owner joined from it (name and address). It
 * holds nothing else of the computer. It never carries a link to itself: the
 * service fills in `remoteAddress` from the address it issued, only while
 * `reach` is `full-control`.
 *
 * - **No agents.** The app sends `agents: []` in every report. The part stays
 *   required, so a report always clears any agents stored before (a present
 *   part replaces that part) and "a part that is absent stays as it was" can
 *   never leave old agents in place.
 * - **`reach` is `chat` or `full-control`** ({@link DirectoryReportReachSchema}):
 *   whether the computer offers its own page. The field still parses `off`, so
 *   a report that parsed before still parses; the app never sends it.
 * - **A report replaces the last one, part by part.** A part that is present
 *   replaces that part: an agent or a space it stops naming leaves the
 *   directory, and `spaces: []` means none. A part that is absent stays as it
 *   was, so a build from before a part existed changes nothing there.
 * - **Older reports lose.** `reportedAt` is when the instance made the report.
 *   The service keeps the newest and drops one older than the last it kept, so
 *   a retried report that arrives late never brings stale entries back.
 * - Send it every `reportEverySeconds` while on. A computer whose owner turns
 *   the link off removes its report with `DELETE /v1/directory/instances/self`,
 *   and the instance stays, listed as `unknown`; one that loses power cannot,
 *   and reads as `offline` once its reports stop.
 *
 * The agents' part is always sent empty (`agents: []`): agents stay on each
 * home, and the availability report a computer sends its spaces is unchanged.
 */
export const DirectoryReportRequestSchema = z
  .object({
    reportedAt: TimestampSchema.describe(
      'When this instance made the report. The service drops one older than the last it kept.'
    ),
    agents: z
      .array(z.object({ agentId: IdSchema, name }))
      .max(DIRECTORY_REPORT_MAX_AGENTS)
      .refine((agents) => new Set(agents.map((agent) => agent.agentId)).size === agents.length, {
        message: 'Name each agent once.',
      })
      .describe(
        'Always sent empty by the app (`[]`): agents stay on each home. Required, so every report clears any agents stored before.'
      ),
    spaces: z
      .array(z.object({ address: HttpsUrlSchema, name }))
      .max(DIRECTORY_REPORT_MAX_SPACES)
      .refine((spaces) => new Set(spaces.map((space) => space.address)).size === spaces.length, {
        message: 'Name each space once.',
      })
      .optional()
      .describe(
        'The spaces this instance joined: name and address only, never its sign-in for them.'
      ),
    reach: DirectoryReachLevelSchema.optional().describe(
      'Whether the computer offers its own page: the app sends full-control while full control is on at the computer, else chat, never off. A hub and an agent computer leave it out. Absent keeps the last value.'
    ),
  })
  .describe(
    'One instance`s report: this computer, whether it offers its own page, and the spaces its owner joined from it. Never agents (`[]`). It replaces the last one.'
  );

/** One instance's whole report. */
export type DirectoryReportRequest = z.infer<typeof DirectoryReportRequestSchema>;

/** What the service did with a report. */
export const DirectoryReportResponseSchema = z
  .object({
    receivedAt: TimestampSchema,
    reportEverySeconds: z.number().int().positive(),
  })
  .describe('The service recorded the report. Send the next one after `reportEverySeconds`.');

/** What the service did with a report. */
export type DirectoryReportResponse = z.infer<typeof DirectoryReportResponseSchema>;

/**
 * `PATCH /v1/directory/settings` — change the account's space learning (and,
 * for a caller other than the app, its quiet hours or time zone).
 *
 * A person's session, or an instance key. The answer is the settings as they
 * now are, applied or not. **The app sends `learnSpacesFromSignIn` only;** it
 * does not write `timeZone`, `quietHours` or `onlyIfUnset`. `onlyIfUnset`
 * applies a change only while the account has no settings yet.
 */
export const DirectorySettingsPatchSchema = z
  .object({
    timeZone: DirectorySettingsSchema.shape.timeZone
      .optional()
      .describe('The account`s time zone. The app does not write it.'),
    quietHours: DirectorySettingsSchema.shape.quietHours
      .optional()
      .describe('The account`s quiet hours. The app does not write them.'),
    learnSpacesFromSignIn: z.boolean().optional(),
    onlyIfUnset: z
      .boolean()
      .optional()
      .describe('Apply only while the account has no settings yet. The app does not send it.'),
  })
  .describe('Change some of the account`s settings. Fields left out stay as they are.');

/** A change to the account's settings. */
export type DirectorySettingsPatch = z.infer<typeof DirectorySettingsPatchSchema>;

/**
 * The answer to `DELETE /v1/directory/instances/self` (the instance's key: its
 * owner turned the link or the report off, so its report leaves the directory
 * without unlinking it; the instance then lists as `unknown`) and
 * `DELETE /v1/directory/spaces/{spaceId}` (a person forgets a space).
 * Both answer even when there was nothing to remove.
 *
 * Forgetting a space sticks. The service keeps a quiet mark, so the next report
 * or sync does not add it straight back; only something new brings it back: a
 * fresh sign-in to it, or a computer joining it again. Forgetting never ends the
 * membership itself.
 */
export const DirectoryRemovedResponseSchema = z
  .object({
    removedAt: TimestampSchema,
  })
  .describe('When the entry left the directory. Answered even when there was nothing to remove.');

/** When an entry left the directory. */
export type DirectoryRemovedResponse = z.infer<typeof DirectoryRemovedResponseSchema>;
