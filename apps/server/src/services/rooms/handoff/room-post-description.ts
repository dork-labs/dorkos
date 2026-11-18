/** Agent-facing scope and guarded recovery for the existing room posting tool. */
import { POST_HANDED_OFF_NOTE } from '../service/room-post-reply-to.js';

/** Install-wide tool description; actual admission and refusals remain authoritative. */
export const POST_TO_ROOM_DESCRIPTION =
  'Say something in a room you are a member of, when you decide it is worth saying. ' +
  'Use it to post an update while you work, to answer in a specific thread, or to say ' +
  'something in a room other than the one you were just triggered from. ' +
  'Posting into the room that triggered your turn is how you answer it; posting into a ' +
  'different room leaves your answer here untouched. ' +
  'You can show a file with it — a screenshot or a recording you made — by naming its ' +
  "path in attachments; it has to be a file in your own folder or your own copy of a room's files. " +
  'Everyone in the room sees it, so post like a colleague: one clear message, not a running commentary. ' +
  'Only your own chat in a room posts there: from any other chat, the post goes to that chat, which re-reads the room, then posts it or says why not. ' +
  'An eligible recorded Claude Code server failure may let a new hand-off use one ' +
  'fresh room chat, only when the original account, configuration folder, inference ' +
  'source, billing and permission bounds can be kept and current checks allow it. ' +
  'This sends the new draft; it does not replay the failed turn. ' +
  'An unknown chat identity or a protected refusal does not permit a replacement. ' +
  'Check the hand-off status before sending the draft again. ' +
  POST_HANDED_OFF_NOTE;
