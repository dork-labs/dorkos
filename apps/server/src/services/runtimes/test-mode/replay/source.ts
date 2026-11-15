import { z } from 'zod';
import type { StreamEvent } from '@dorkos/shared/types';
import { ReplayHome } from './home.js';

/** Visible on every recorded reply, tool display, and chat title. */
export const RECORDED_DEMO_LABEL = 'Recorded demo';
/** Bounds both disk reads and schema parsing, before allocating decoded objects. */
export const MAX_RECORDING_BYTES = 1_048_576;
const displayString = z.string().max(65_536);
const textEvent = z
  .object({
    type: z.literal('text_delta'),
    data: z.object({ text: displayString }).strict(),
  })
  .strict();
const toolEvent = z
  .object({
    type: z.enum(['tool_call_start', 'tool_call_delta', 'tool_call_end', 'tool_result']),
    data: z
      .object({
        toolCallId: z.string().min(1).max(200),
        toolName: z.string().min(1).max(200),
        status: z.enum(['pending', 'running', 'complete', 'error']),
        input: displayString.optional(),
        result: displayString.optional(),
      })
      .strict(),
  })
  .strict();
const recordingSchema = z
  .object({
    version: z.literal(1),
    title: z.string().min(1).max(120),
    turns: z
      .array(
        z
          .object({
            events: z
              .array(z.union([textEvent, toolEvent]))
              .min(1)
              .max(1000),
          })
          .strict()
          .refine(
            (turn) =>
              !/dorkos-ui/i.test(
                turn.events
                  .map((event) =>
                    event.type === 'text_delta'
                      ? event.data.text
                      : `${event.data.input ?? ''}${event.data.result ?? ''}`
                  )
                  .join('')
              ),
            'Recordings cannot contain live widgets.'
          )
      )
      .min(1)
      .max(100),
  })
  .strict();

/** A data-only scenario source. It never receives tools, a dispatcher, or model clients. */
export class ReplaySource {
  readonly home: ReplayHome;
  private readonly recording: z.infer<typeof recordingSchema>;
  private readonly nextTurns = new Map<string, number>();

  constructor(dorkHome: string, recordingPath: string) {
    this.home = new ReplayHome(dorkHome);
    this.recording = recordingSchema.parse(
      JSON.parse(this.home.readRecording(recordingPath, MAX_RECORDING_BYTES))
    );
  }

  /** The chat keeps its demo label even if a person renames it. */
  title(title = this.recording.title): string {
    return `${RECORDED_DEMO_LABEL}: ${title.replace(/^Recorded demo:\s*/, '')}`;
  }

  /** Start the recording again after the test-control reset clears tracked chats. */
  reset(): void {
    this.nextTurns.clear();
  }

  /** Validate before the runtime reads settings or opens its scripted interaction gate. */
  assertCurrent(): void {
    this.home.assertCurrent();
  }

  /** Yield display events only; terminal/session identities are owned by this runtime. */
  async *play(sessionId: string): AsyncGenerator<StreamEvent> {
    this.assertCurrent();
    const index = this.nextTurns.get(sessionId) ?? 0;
    const turn = this.recording.turns[index];
    if (!turn) throw new Error('Recording finished. Start a new demo chat.');
    this.nextTurns.set(sessionId, index + 1);
    yield { type: 'text_delta', data: { text: `${RECORDED_DEMO_LABEL}\n\n` } };
    for (const event of turn.events) {
      this.assertCurrent();
      if (event.type === 'text_delta') {
        yield { type: 'text_delta', data: { text: event.data.text } };
      } else {
        yield {
          type: event.type,
          data: {
            ...event.data,
            toolName: `${RECORDED_DEMO_LABEL}: ${event.data.toolName}`,
            ...(event.data.result !== undefined && {
              result: `${RECORDED_DEMO_LABEL}: ${event.data.result}`,
            }),
          },
        };
      }
    }
    yield { type: 'done', data: { sessionId } };
  }
}
