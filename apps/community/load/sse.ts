import type { LatencyHistogram } from './histogram.js';

/** How one reader's stream ended, once it has. */
export interface ReaderOutcome {
  /** Whether the stream opened: a 200 with a body, and its `snapshot` frame read. */
  opened: boolean;
  /** The HTTP status, when the stream never opened. */
  status?: number;
  /** Milliseconds from asking for the stream to reading its `snapshot` frame. */
  openMs?: number;
  /** When the `snapshot` frame was read, on the {@link loadClock}. */
  openedAt?: number;
  /**
   * The stream closed, or errored, before the run told it to stop: a drop. A healthy run sees
   * this on no reader, because every open stream should still be open when the script ends it.
   */
  endedEarly: boolean;
  /** The server's own reason, from a `closed` event, if the stream got one. */
  closeReason?: string;
  /** A network-level failure's message, if the stream ended that way. */
  error?: string;
  /** How many distinct posts of this run reached this stream, live or in its snapshot. */
  received: number;
}

/**
 * The clock every timestamp in a run is read from, in milliseconds.
 *
 * `process.hrtime` is monotonic and is one clock for every thread in the process, so the reader
 * threads and the writer thread read the same scale, and the system clock stepping mid-run
 * cannot bend a sample. Readers and writers run on one machine, so there is no skew between
 * machines to correct for. Its zero point is arbitrary: only differences mean anything.
 */
export function loadClock(): number {
  return Number(process.hrtime.bigint()) / 1e6;
}

/**
 * The marker each post carries in its text: the run it belongs to, its number, and the
 * scheduled send time on the {@link loadClock}.
 */
export interface TimedPost {
  r: string;
  n: number;
  t: number;
}

/** Read a post's text back into its marker, or `null` when it is not one of `runId`'s posts. */
export function parseTimedPost(text: string, runId: string): TimedPost | null {
  try {
    const value = JSON.parse(text) as Partial<TimedPost> | null;
    if (
      value !== null &&
      typeof value === 'object' &&
      value.r === runId &&
      typeof value.n === 'number' &&
      typeof value.t === 'number'
    ) {
      return value as TimedPost;
    }
  } catch {
    // Not one of this run's posts: never counted.
  }
  return null;
}

/** One SSE frame, as the Community server writes it: `id:`, `event:`, one `data:` line. */
export interface SseFrame {
  type: string;
  data: unknown;
}

/**
 * Split the frames out of `buffer`, returning them and whatever trailing partial frame is left.
 * Comment frames (the `: keepalive` heartbeat) and frames that do not parse are skipped.
 */
export function takeFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  // A large frame arrives in many chunks; do not re-split it until it is whole.
  if (!buffer.includes('\n\n')) return { frames: [], rest: buffer };
  const frames: SseFrame[] = [];
  const blocks = buffer.split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    let type = 'message';
    const data: string[] = [];
    for (const rawLine of block.split('\n')) {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) type = line.slice('event:'.length).trimStart();
      else if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
    }
    if (!data.length) continue;
    try {
      frames.push({ type, data: JSON.parse(data.join('\n')) });
    } catch {
      // A malformed frame is not a delivery.
    }
  }
  return { frames, rest };
}

/** The entry texts a frame carries: one for `entry`, every snapshot entry for `snapshot`. */
function textsOf(frame: SseFrame): string[] {
  const data = frame.data as {
    entry?: { text?: unknown };
    entries?: Array<{ text?: unknown }>;
  };
  if (frame.type === 'entry') return typeof data.entry?.text === 'string' ? [data.entry.text] : [];
  if (frame.type === 'snapshot' && Array.isArray(data.entries))
    return data.entries.flatMap((e) => (typeof e.text === 'string' ? [e.text] : []));
  return [];
}

/**
 * Open one reader's live stream and read it until the run aborts `signal` or the stream ends on
 * its own (a drop). `onSettled` fires once, when the stream has opened (its snapshot is read) or
 * failed to. Every live `entry` frame carrying one of this run's posts records `now - t` as one
 * delivery sample, where `t` is when the post was SCHEDULED to be sent, not when it went out: a
 * load generator that falls behind its own schedule shows up as latency instead of hiding it
 * (coordinated omission). Posts already in the opening snapshot count as received but carry no
 * latency sample; the run waits for every stream to open before posting, so normally none do.
 */
export async function openReaderStream(input: {
  baseUrl: string;
  communityId: string;
  channelId: string;
  token: string;
  runId: string;
  /** How many posts the run schedules at most: sizes this reader's record of what it saw. */
  postCapacity: number;
  signal: AbortSignal;
  deliveries: LatencyHistogram;
  onSettled: (opened: boolean) => void;
  /** Called once for each distinct post of this run that reaches this stream. */
  onReceived?: () => void;
}): Promise<ReaderOutcome> {
  let settled = false;
  const settle = (opened: boolean) => {
    if (settled) return;
    settled = true;
    input.onSettled(opened);
  };
  try {
    return await readStream(input, settle);
  } finally {
    settle(false);
  }
}

async function readStream(
  input: Omit<Parameters<typeof openReaderStream>[0], 'onSettled'>,
  settle: (opened: boolean) => void
): Promise<ReaderOutcome> {
  const streamUrl = `${input.baseUrl}/api/v1/communities/${input.communityId}/channels/${input.channelId}/events`;
  const askedAt = loadClock();
  // One byte per scheduled post rather than a Set: at 20,000 readers a Set per reader would cost
  // gigabytes, and the load generator must not be what runs out of memory.
  const seen = new Uint8Array(input.postCapacity);
  let received = 0;
  let response: Response;
  try {
    response = await fetch(streamUrl, {
      headers: { authorization: `Bearer ${input.token}`, accept: 'text/event-stream' },
      signal: input.signal,
    });
  } catch (error) {
    return input.signal.aborted
      ? { opened: false, endedEarly: false, error: 'aborted before opening', received: 0 }
      : { opened: false, endedEarly: false, error: String(error), received: 0 };
  }
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    return { opened: false, status: response.status, endedEarly: false, received: 0 };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let openedAt: number | undefined;
  let closeReason: string | undefined;
  const outcome = (endedEarly: boolean, error?: string): ReaderOutcome =>
    openedAt === undefined
      ? // Never opened: an open failure, not also a drop.
        {
          opened: false,
          endedEarly: false,
          error:
            error ??
            closeReason ??
            (input.signal.aborted ? 'not open when the run ended' : 'ended before its snapshot'),
          received,
        }
      : {
          opened: true,
          openMs: openedAt - askedAt,
          openedAt,
          endedEarly,
          closeReason,
          error,
          received,
        };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { frames, rest } = takeFrames(buffer);
      buffer = rest;
      const now = loadClock();
      for (const frame of frames) {
        if (frame.type === 'snapshot' && openedAt === undefined) {
          openedAt = now;
          settle(true);
        }
        if (frame.type === 'closed')
          closeReason = String((frame.data as { reason?: unknown }).reason ?? 'unknown');
        for (const text of textsOf(frame)) {
          const post = parseTimedPost(text, input.runId);
          if (!post || !Number.isInteger(post.n) || post.n < 0 || post.n >= seen.length) continue;
          if (seen[post.n]) continue;
          seen[post.n] = 1;
          received += 1;
          input.onReceived?.();
          if (frame.type === 'entry') input.deliveries.record(now - post.t);
        }
      }
    }
    return outcome(!input.signal.aborted);
  } catch (error) {
    return input.signal.aborted ? outcome(false) : outcome(true, String(error));
  } finally {
    // Gives the socket back on every path; a no-op once the stream ended or was aborted.
    await reader.cancel().catch(() => undefined);
  }
}
