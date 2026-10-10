/**
 * Two real channels where a person posted and nobody answered (DOR-2823).
 *
 * Read from a real room log on 2026-10-09 and reduced to what the
 * routing rules read: who wrote each post (by role, not by name), when, which
 * thread it sat in, and whom it @mentioned. Every message body is left out.
 * `seq` is the real sequence number, so a case here can be checked against the
 * ticket's list.
 *
 * - `AGENT` is the agent the person was talking to in that room.
 * - `OTHER_AGENT` is a different agent that is a member of the same room.
 * - `SYSTEM` is the room's own voice (notices, canvas updates).
 *
 * @module server/services/rooms/tests/real-room-misses-fixture
 */

/** Who wrote one post, by role in the conversation. */
export type FixtureAuthor = 'HUMAN' | 'AGENT' | 'OTHER_AGENT' | 'SYSTEM';

/** One row of a real room log, reduced to what routing reads. */
export interface FixtureEntry {
  /** The real sequence number in that room. */
  seq: number;
  /** Who wrote it. */
  author: FixtureAuthor;
  /** `post` or `notice`. */
  kind: 'post' | 'notice';
  /** When it landed, as stored. */
  at: string;
  /** Whom it @mentioned, by role. */
  mentions?: Array<'AGENT' | 'HUMAN' | 'OTHER'>;
  /** The `seq` of its thread's root, when it sits in a thread. */
  root?: number;
}

/** The first channel, seq 29 to 53. */
export const ROOM_A: readonly FixtureEntry[] = [
  {
    seq: 29,
    author: 'OTHER_AGENT',
    kind: 'post',
    at: '2026-10-09T16:33:07.982Z',
    mentions: ['AGENT'],
  },
  { seq: 30, author: 'SYSTEM', kind: 'notice', at: '2026-10-09T16:33:08.496Z' },
  { seq: 31, author: 'HUMAN', kind: 'post', at: '2026-10-09T19:34:49.170Z', mentions: ['AGENT'] },
  { seq: 32, author: 'AGENT', kind: 'post', at: '2026-10-09T19:36:00.927Z', mentions: ['HUMAN'] },
  { seq: 33, author: 'SYSTEM', kind: 'post', at: '2026-10-09T19:36:17.539Z' },
  {
    seq: 34,
    author: 'HUMAN',
    kind: 'post',
    at: '2026-10-09T19:40:09.146Z',
    mentions: ['OTHER'],
    root: 29,
  },
  { seq: 35, author: 'OTHER_AGENT', kind: 'post', at: '2026-10-09T19:40:35.515Z', root: 29 },
  { seq: 36, author: 'HUMAN', kind: 'post', at: '2026-10-09T19:45:34.222Z', mentions: ['AGENT'] },
  { seq: 37, author: 'AGENT', kind: 'post', at: '2026-10-09T19:45:47.557Z', mentions: ['HUMAN'] },
  { seq: 38, author: 'HUMAN', kind: 'post', at: '2026-10-09T19:47:50.674Z' },
  { seq: 39, author: 'AGENT', kind: 'post', at: '2026-10-09T19:48:03.115Z', mentions: ['HUMAN'] },
  { seq: 40, author: 'HUMAN', kind: 'post', at: '2026-10-09T20:04:35.288Z', mentions: ['AGENT'] },
  { seq: 41, author: 'AGENT', kind: 'post', at: '2026-10-09T20:10:18.948Z', mentions: ['HUMAN'] },
  { seq: 42, author: 'SYSTEM', kind: 'post', at: '2026-10-09T20:10:39.276Z' },
  { seq: 43, author: 'HUMAN', kind: 'post', at: '2026-10-09T20:15:31.183Z' },
  { seq: 44, author: 'HUMAN', kind: 'post', at: '2026-10-09T20:15:46.884Z', mentions: ['AGENT'] },
  { seq: 45, author: 'AGENT', kind: 'post', at: '2026-10-09T20:18:50.010Z', mentions: ['HUMAN'] },
  { seq: 46, author: 'HUMAN', kind: 'post', at: '2026-10-09T21:32:09.466Z', mentions: ['AGENT'] },
  {
    seq: 47,
    author: 'AGENT',
    kind: 'post',
    at: '2026-10-09T21:32:31.784Z',
    mentions: ['HUMAN'],
    root: 46,
  },
  { seq: 48, author: 'HUMAN', kind: 'post', at: '2026-10-09T21:40:08.748Z', root: 46 },
  {
    seq: 49,
    author: 'HUMAN',
    kind: 'post',
    at: '2026-10-09T21:40:24.266Z',
    mentions: ['AGENT'],
    root: 46,
  },
  {
    seq: 50,
    author: 'AGENT',
    kind: 'post',
    at: '2026-10-09T21:40:52.291Z',
    mentions: ['HUMAN'],
    root: 46,
  },
  { seq: 51, author: 'HUMAN', kind: 'post', at: '2026-10-09T22:02:50.723Z', root: 46 },
  {
    seq: 52,
    author: 'HUMAN',
    kind: 'post',
    at: '2026-10-09T22:03:07.963Z',
    mentions: ['AGENT'],
    root: 46,
  },
  {
    seq: 53,
    author: 'AGENT',
    kind: 'post',
    at: '2026-10-09T22:05:10.408Z',
    mentions: ['HUMAN'],
    root: 46,
  },
];

/** The second channel, seq 266 to 320. */
export const ROOM_B: readonly FixtureEntry[] = [
  { seq: 266, author: 'HUMAN', kind: 'post', at: '2026-09-18T20:32:22.128Z' },
  { seq: 267, author: 'AGENT', kind: 'post', at: '2026-09-18T20:33:00.626Z' },
  { seq: 268, author: 'HUMAN', kind: 'post', at: '2026-09-18T20:34:01.671Z', mentions: ['AGENT'] },
  { seq: 269, author: 'AGENT', kind: 'post', at: '2026-09-18T20:34:18.676Z' },
  { seq: 270, author: 'HUMAN', kind: 'post', at: '2026-09-18T20:41:43.035Z', mentions: ['AGENT'] },
  { seq: 271, author: 'AGENT', kind: 'post', at: '2026-09-18T20:42:23.560Z' },
  { seq: 272, author: 'HUMAN', kind: 'post', at: '2026-09-23T13:30:24.405Z' },
  { seq: 273, author: 'HUMAN', kind: 'post', at: '2026-09-23T13:30:38.448Z', mentions: ['AGENT'] },
  { seq: 274, author: 'AGENT', kind: 'post', at: '2026-09-23T13:33:12.745Z', root: 273 },
  { seq: 275, author: 'HUMAN', kind: 'post', at: '2026-10-01T15:29:36.229Z' },
  { seq: 276, author: 'HUMAN', kind: 'post', at: '2026-10-01T15:29:51.269Z', mentions: ['AGENT'] },
  { seq: 277, author: 'AGENT', kind: 'post', at: '2026-10-01T15:31:25.976Z', root: 276 },
  { seq: 278, author: 'AGENT', kind: 'post', at: '2026-10-01T15:32:50.033Z', root: 276 },
  { seq: 279, author: 'HUMAN', kind: 'post', at: '2026-10-01T15:57:04.961Z', root: 276 },
  {
    seq: 280,
    author: 'HUMAN',
    kind: 'post',
    at: '2026-10-01T15:57:18.047Z',
    mentions: ['AGENT'],
    root: 276,
  },
  { seq: 281, author: 'AGENT', kind: 'post', at: '2026-10-01T15:57:43.211Z', root: 276 },
  { seq: 282, author: 'HUMAN', kind: 'post', at: '2026-10-01T15:59:17.983Z', root: 276 },
  { seq: 283, author: 'AGENT', kind: 'post', at: '2026-10-01T16:00:18.495Z', root: 276 },
  { seq: 284, author: 'AGENT', kind: 'post', at: '2026-10-05T14:00:33.030Z', mentions: ['HUMAN'] },
  { seq: 285, author: 'HUMAN', kind: 'post', at: '2026-10-05T15:32:39.168Z', mentions: ['AGENT'] },
  { seq: 286, author: 'HUMAN', kind: 'post', at: '2026-10-05T15:33:29.364Z' },
  { seq: 287, author: 'AGENT', kind: 'post', at: '2026-10-05T15:33:33.771Z', root: 285 },
  { seq: 288, author: 'AGENT', kind: 'post', at: '2026-10-05T15:34:16.344Z', root: 285 },
  { seq: 289, author: 'HUMAN', kind: 'post', at: '2026-10-05T15:35:55.364Z', root: 285 },
  {
    seq: 290,
    author: 'HUMAN',
    kind: 'post',
    at: '2026-10-05T15:36:06.386Z',
    mentions: ['AGENT'],
    root: 285,
  },
  { seq: 291, author: 'AGENT', kind: 'post', at: '2026-10-05T15:37:55.941Z', root: 285 },
  {
    seq: 292,
    author: 'HUMAN',
    kind: 'post',
    at: '2026-10-05T15:40:19.302Z',
    mentions: ['AGENT'],
    root: 285,
  },
  { seq: 293, author: 'HUMAN', kind: 'post', at: '2026-10-05T15:41:13.050Z', root: 285 },
  { seq: 294, author: 'AGENT', kind: 'post', at: '2026-10-05T15:41:20.866Z', root: 285 },
  { seq: 295, author: 'HUMAN', kind: 'post', at: '2026-10-05T18:31:45.631Z', mentions: ['AGENT'] },
  { seq: 296, author: 'AGENT', kind: 'post', at: '2026-10-05T18:32:49.557Z', root: 295 },
  { seq: 297, author: 'HUMAN', kind: 'post', at: '2026-10-05T18:34:37.808Z', root: 295 },
  {
    seq: 298,
    author: 'HUMAN',
    kind: 'post',
    at: '2026-10-05T18:34:49.324Z',
    mentions: ['AGENT'],
    root: 295,
  },
  { seq: 299, author: 'AGENT', kind: 'post', at: '2026-10-05T18:35:14.272Z', root: 295 },
  { seq: 300, author: 'HUMAN', kind: 'post', at: '2026-10-06T15:48:17.312Z', mentions: ['AGENT'] },
  { seq: 301, author: 'AGENT', kind: 'post', at: '2026-10-06T15:49:10.693Z', root: 300 },
  { seq: 302, author: 'AGENT', kind: 'post', at: '2026-10-06T15:51:16.125Z', root: 300 },
  { seq: 303, author: 'HUMAN', kind: 'post', at: '2026-10-06T15:55:44.564Z', root: 300 },
  {
    seq: 304,
    author: 'HUMAN',
    kind: 'post',
    at: '2026-10-06T15:56:17.123Z',
    mentions: ['AGENT'],
    root: 300,
  },
  { seq: 305, author: 'AGENT', kind: 'post', at: '2026-10-06T15:57:45.013Z', root: 300 },
  { seq: 306, author: 'HUMAN', kind: 'post', at: '2026-10-09T16:30:12.175Z', mentions: ['AGENT'] },
  { seq: 307, author: 'AGENT', kind: 'post', at: '2026-10-09T16:31:32.382Z', root: 306 },
  { seq: 308, author: 'HUMAN', kind: 'post', at: '2026-10-09T16:33:53.942Z', root: 306 },
  {
    seq: 309,
    author: 'HUMAN',
    kind: 'post',
    at: '2026-10-09T16:34:07.587Z',
    mentions: ['AGENT'],
    root: 306,
  },
  { seq: 310, author: 'AGENT', kind: 'post', at: '2026-10-09T16:35:51.819Z', root: 306 },
  { seq: 311, author: 'HUMAN', kind: 'post', at: '2026-10-09T16:49:06.592Z', root: 306 },
  {
    seq: 312,
    author: 'HUMAN',
    kind: 'post',
    at: '2026-10-09T16:49:51.230Z',
    mentions: ['AGENT'],
    root: 306,
  },
  { seq: 313, author: 'AGENT', kind: 'post', at: '2026-10-09T16:52:01.331Z', root: 306 },
  { seq: 314, author: 'HUMAN', kind: 'post', at: '2026-10-09T16:56:58.439Z', root: 306 },
  { seq: 315, author: 'AGENT', kind: 'post', at: '2026-10-09T16:57:24.422Z', root: 306 },
  { seq: 316, author: 'HUMAN', kind: 'post', at: '2026-10-09T17:00:45.111Z', root: 306 },
  {
    seq: 317,
    author: 'HUMAN',
    kind: 'post',
    at: '2026-10-09T17:00:56.652Z',
    mentions: ['AGENT'],
    root: 306,
  },
  { seq: 318, author: 'AGENT', kind: 'post', at: '2026-10-09T17:01:35.280Z', root: 306 },
  {
    seq: 319,
    author: 'HUMAN',
    kind: 'post',
    at: '2026-10-09T17:53:39.041Z',
    mentions: ['AGENT'],
    root: 306,
  },
  { seq: 320, author: 'AGENT', kind: 'post', at: '2026-10-09T17:54:46.515Z', root: 306 },
];
