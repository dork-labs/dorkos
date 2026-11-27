import { z } from 'zod';

import { IdSchema, TimestampSchema } from './primitives.js';
import { PageLinkKeySchema, PageReportReasonReadSchema } from './published-pages.js';
import { HandleSchema } from './seats.js';

/*
 * The instance command stream: what the service asks an instance to do, and
 * how the instance reports what it did. Moved out of `remote.ts` unchanged,
 * so that file stays under its size limit.
 */

/**
 * One event on the instance command stream.
 *
 * A take-down's `reason` reads tolerantly through a transform, so generate
 * this schema's JSON Schema with `{ io: 'input' }`.
 *
 * A published discriminated union rather than an untyped string, so adding a
 * command kind later is a package release the two sides can agree on rather
 * than a field they disagree about.
 *
 * A build from before a kind was published cannot parse it, so it never
 * acknowledges it and logs that it ignored it. The service sends a newer kind
 * only to an instance whose reported version knows it: `viewer_open` and
 * `hub_assignment_changed` reach the builds that published them,
 * `agent_computer_assignment_changed` reaches only an agent computer whose
 * version knows it, and `page_take_down` only a hub whose build serves
 * published pages (an earlier build carries the schema but drops the kind).
 */
export const RemoteCommandSchema = z
  .discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('open'),
        id: IdSchema,
        leaseToken: z.string().min(1),
        wakeId: IdSchema,
        leaseId: IdSchema.optional().describe(
          'The lease the instance echoes when it reconnects. Opaque: the instance stores it and sends it back, and reads nothing from it.'
        ),
        address: z
          .string()
          .optional()
          .describe('The address this instance is reachable at once the tunnel is open.'),
        host: z.string().optional().describe('The host part of that address.'),
        idleWindowSeconds: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            'How long the tunnel may sit idle before it closes itself, in seconds. The same window `RemoteStatusSchema` reports.'
          ),
        drainDeadlineSeconds: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            'How long the instance has to finish work already in flight once it is asked to close, in seconds.'
          ),
      })
      .describe('Open the tunnel.'),
    z
      .object({
        kind: z.literal('close'),
        id: IdSchema,
        leaseToken: z.string().min(1),
        reason: z.string(),
      })
      .describe('Close the tunnel.'),
    z
      .object({
        kind: z.literal('rotate'),
        id: IdSchema,
        leaseToken: z.string().min(1),
        credentialId: IdSchema.describe(
          'An issue key, not a credential id. Present it as the `idempotencyKey` of `POST /v1/remote/credentials/issue` to receive the replacement, then confirm the replacement with the `credentialId` that call returns. If that call is refused, keep using the current credential; the service may offer another replacement later.'
        ),
      })
      .describe(
        'Replace the tunnel credential. Nothing is created until the instance asks for it, with the id this command carries.'
      ),
    z
      .object({
        kind: z.literal('revoke'),
        id: IdSchema,
        leaseToken: z.string().min(1),
        credentialId: IdSchema,
      })
      .describe('Stop using the tunnel credential and forget it.'),
    z
      .object({
        kind: z.literal('inbox_pending'),
        id: IdSchema,
        leaseToken: z.string().min(1),
        seatId: IdSchema,
      })
      .describe('There is mail waiting for a seat.'),
    z
      .object({
        kind: z.literal('viewer_open'),
        id: IdSchema,
        leaseToken: z.string().min(1),
        expiresAt: TimestampSchema.describe(
          'Dial before this. A command read after it is acknowledged `ignored`.'
        ),
      })
      .describe(
        'Somebody opened a chat of this computer`s on its hub: dial the hub address and key this computer pinned. Carries no address, on purpose.'
      ),
    z
      .object({
        kind: z.literal('hub_assignment_changed'),
        id: IdSchema,
        leaseToken: z.string().min(1),
      })
      .describe(
        'For a hub only: read `GET /v1/hubs/self/assignment` again now, because its front-door proof was replaced or it ended. Carries nothing else, and no authority.'
      ),
    z
      .object({
        kind: z.literal('page_take_down'),
        id: IdSchema,
        leaseToken: z.string().min(1),
        linkKey: PageLinkKeySchema.describe('The page to take down, by its link key.'),
        reason: PageReportReasonReadSchema.describe(
          'Why the service took it down. The hub tells the owner why in the app`s own words for this reason. A reason this release does not know reads as other.'
        ),
      })
      .describe(
        'For a hub only: take this published page down as its owner`s own take-down does, record the hosted service as the actor, and tell the owner why. `applied`: its files are gone and its link answers as a taken-down page. `ignored`: no such page, or already down, or a repeat. `failed`: the hub could not. Carries no free text from the service. A hub knows this kind from the build that serves published pages, not the first build that carries the schema; the service sends it to no hub before that.'
      ),
    z
      .object({
        kind: z.literal('agent_computer_assignment_changed'),
        id: IdSchema,
        leaseToken: z.string().min(1),
      })
      .describe(
        'For an agent computer only: read `GET /v1/agent-computers/self/assignment` again now, because its link code or its hub changed. Carries nothing else, and no authority. Sent only to a computer whose version knows it.'
      ),
    z
      .object({
        kind: z.literal('keepalive'),
        id: IdSchema,
        reconnectAfterMs: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe(
            'How long to wait before reconnecting if the stream drops. A convenience rather than a gap: the server-sent-events `retry:` field already carries the same number, and an instance that honours it needs nothing here.'
          ),
      })
      .describe('Nothing to do. Sent so a silent stream can be told from a dead one.'),
  ])
  .describe(
    'One event on the `GET /v1/remote/commands` stream. Server-sent events; instance API key only.'
  );

/** One event on the instance command stream. */
export type RemoteCommand = z.infer<typeof RemoteCommandSchema>;

/**
 * What an instance did with one command it leased.
 *
 * Three settled outcomes, plus an open `refused:<slug>` family for a command an
 * instance declined and can say why. The slug is bounded by {@link HandleSchema},
 * so a refusal reason is a single lower-case routing token a log and a dashboard
 * can group by without parsing prose.
 *
 * The family is open on purpose, and it is mechanism rather than catalog: a new
 * reason to refuse a command is something the server learns to say without a
 * package release, and no refusal names a subscription, a supplier or an
 * amount. A client that does not recognise a slug shows the whole string.
 *
 * Built from the handle grammar itself rather than from a copy of its pattern,
 * for two reasons. The two cannot drift apart while the doc above claims they
 * match. And a template literal keeps the three settled outcomes narrowable: a
 * plain `z.string()` branch would infer as `string`, which swallows the union
 * and silently turns an exhaustive switch over this field into one TypeScript
 * can no longer check.
 */
export const RemoteCommandOutcomeSchema = z
  .union([z.enum(['applied', 'ignored', 'failed']), z.templateLiteral(['refused:', HandleSchema])])
  .describe(
    'What the instance did with a command: applied, ignored, failed, or refused with a slug bounded by the handle grammar.'
  );

/** What an instance did with one command it leased. */
export type RemoteCommandOutcome = z.infer<typeof RemoteCommandOutcomeSchema>;

/** `POST /v1/remote/commands/ack`. */
export const RemoteCommandAckRequestSchema = z
  .object({
    items: z
      .array(
        z.object({
          id: IdSchema,
          leaseToken: z.string().min(1),
          outcome: RemoteCommandOutcomeSchema.describe('What the instance did with the command.'),
        })
      )
      .min(1)
      .max(100),
  })
  .describe('Report what an instance did with the commands it leased.');

/** How many command leases were settled. */
export const RemoteCommandAckResponseSchema = z
  .object({ acknowledged: z.number().int().nonnegative() })
  .describe('How many command leases the server settled.');
