import { z } from 'zod';

/**
 * A seat preview for one invite to a hosted space.
 *
 * Before a person makes an invite link for a hosted team space, the app shows
 * one line about seats: how many are used, how many are included, whether one
 * more person would add a seat, and who pays. The numbers are
 * the service's, and the two sentences are the service's own words. The app
 * shows them as given and never parses them. There is no price here: what a
 * seat costs is the service's to say, in its own words, on its own pages.
 *
 * `GET /v1/communities/{communityId}/seat-preview` answers it. It is a preview
 * and nothing more: it makes no invite, holds no seat and promises nothing.
 * The service checks for real when a person opens the link and joins.
 *
 * It takes the space and nothing else: no address, because nobody knows who
 * will open a link, and no role, because an invite from the app makes a
 * member. The service works out whose seats the space counts.
 *
 * Who may ask: an owner or an admin of that space, signed in as themselves.
 * An agent never asks. A member who is neither is `forbidden`. A space the
 * caller cannot see and a space that does not exist get the same `not_found`.
 *
 * When the service would refuse one more person, the answer is the existing
 * `person_seat_required` refusal (a `Problem`) with the service's words and an
 * `actionUrl` to open, so the app can show it before the link is made.
 *
 * A team space on a person's own server has no hosted seats. The app never
 * asks for one, and shows no line there.
 */

/**
 * `GET /v1/communities/{communityId}/seat-preview`: what one more invite does
 * to the seats a hosted space counts.
 */
export const CommunitySeatPreviewSchema = z
  .object({
    seatsUsed: z
      .number()
      .int()
      .nonnegative()
      .describe(
        'How many seats the space`s account counts as used now, as the service counts them.'
      ),
    seatsIncluded: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe(
        'How many seats are included, as the service counts them. Null means no fixed number; what that means for one more person is the service`s to say in addsSeat.'
      ),
    addsSeat: z
      .boolean()
      .describe(
        'The service`s own answer to: would one more person, who does not already hold a seat here, add a seat to what the payer is counted for? Nobody knows yet who will open the link, so it is about one more person, not a named one. It is independent of seatsIncluded: the contract puts no rule between them. Show the service`s words; use this for emphasis only.'
      ),
    summary: z
      .string()
      .min(1)
      .max(280)
      .describe(
        'One line about seats for this invite, in the service`s own words. Show it as given; never parse it.'
      ),
    payer: z
      .string()
      .min(1)
      .max(280)
      .describe(
        'Who pays for a seat this invite adds, in the service`s own words: named by a display name or a role, never an email address or a billing detail. Show it as given; never parse it.'
      ),
  })
  .describe(
    'A seat preview for one invite to a hosted space: numbers and the service`s words, no price. A preview only: it makes no invite, holds no seat and promises nothing.'
  );

/** A seat preview for one invite to a hosted space. */
export type CommunitySeatPreview = z.infer<typeof CommunitySeatPreviewSchema>;
