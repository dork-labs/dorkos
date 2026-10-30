/**
 * The `replyTo` argument of `post_to_room`, kept apart from the capability file
 * so what it says can grow without that file growing.
 *
 * **Leaving it out is the usual case, and it answers where the agent was asked**
 * (FB-63): `RoomPosting.postFromTool` lands a post with no `replyTo` in the
 * thread of the message the turn is answering, and reads a reply it names as
 * that reply's thread. The description says so because an agent that believes
 * it must name the thread will name the reply it was handed, and that used to
 * be refused.
 */
import { z } from 'zod';

/** The schema for `post_to_room`'s `replyTo`. */
export const POST_REPLY_TO_INPUT = z
  .string()
  .optional()
  .describe(
    'Reply inside a thread: the entryId the thread hangs off, or any reply in it. ' +
      'Leave it out to answer where you were asked: in a thread when a thread ' +
      'message started your turn here, at the top level otherwise.'
  );
