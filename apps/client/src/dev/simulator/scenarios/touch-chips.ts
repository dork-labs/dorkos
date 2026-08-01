import { createUserMessage, createAssistantMessage, createToolCall } from '../../mock-chat-data';
import { buildStreamingTextSteps } from '../sim-helpers';
import type { SimScenario, SimStep } from '../sim-types';

const MSG = 'sim-tc-asst';

const USER_MSG = createUserMessage({
  id: 'sim-tc-user',
  content: 'Clean up the event mapper and check what still links to the old docs.',
});

const ASST_MSG = createAssistantMessage({
  id: 'sim-tc-asst',
  content: '',
  parts: [{ type: 'text', text: '' }],
  // The turn is running. Real streaming tags the in-progress bubble the same
  // way, and it is what holds the chip strip's live row up through the gaps
  // between tool calls — without it the row would collapse into the summary
  // line and reopen a dozen times in this scenario, which is the thing the
  // scenario exists to let a reviewer watch NOT happen.
  _streaming: true,
});

const INTRO_TEXT = "Let me look at what's there first, then work through it.\n\n";

const CLOSING_TEXT =
  '\n\nDone. The mapper now derives its own events, the legacy mapper is gone, and the two doc links still resolve.\n\n';

/**
 * One tool's whole life, as three steps: it appears, it runs, it settles.
 *
 * `startAfter` is the pause before it appears — the gap between arrivals is
 * what this scenario is really about — and `runsFor` is how long it stays live,
 * which is how long its verb signature has to play.
 */
function tool(options: {
  id: string;
  toolName: string;
  input: unknown;
  result?: string;
  startAfter?: number;
  runsFor?: number;
}): SimStep[] {
  const { id, toolName, input, result, startAfter = 200, runsFor = 700 } = options;
  return [
    {
      type: 'append_tool_call',
      messageId: MSG,
      toolCall: createToolCall({
        toolCallId: id,
        toolName,
        input: JSON.stringify(input),
        status: 'pending',
      }),
      delayMs: startAfter,
    },
    {
      type: 'update_tool_call',
      messageId: MSG,
      toolCallId: id,
      patch: { status: 'running' },
      delayMs: 100,
    },
    {
      type: 'update_tool_call',
      messageId: MSG,
      toolCallId: id,
      patch: { status: 'complete', result },
      delayMs: runsFor,
    },
  ];
}

/**
 * A turn that touches enough things, fast enough, to exercise the chip strip
 * end to end: bursty arrivals, a long quiet gap, a file that is read and then
 * changed, a deletion, a batch of links, and one command that takes its time.
 *
 * This is the only place absorption timing can actually be watched. The unit
 * tests fold a finished transcript in one pass; what they cannot show is four
 * chips arriving inside a second, the fifth pushing the oldest into the pile,
 * and every loop going still during the ten seconds where nothing happens.
 */
export const touchChips: SimScenario = {
  id: 'touch-chips',
  title: 'Touch Chips',
  description: 'Bursty tool arrivals, an idle gap, a read-then-edit, an rm, and a fetch batch',
  steps: [
    { type: 'append_message', message: USER_MSG, delayMs: 300 },
    { type: 'set_status', status: 'streaming' },
    { type: 'append_message', message: ASST_MSG, delayMs: 400 },
    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps(MSG, INTRO_TEXT),
    { type: 'set_streaming', isTextStreaming: false },

    // Burst one: three tools inside about a second. The row fills; nothing has
    // aged out yet, so there is no pile.
    ...tool({
      id: 'sim-tc-read-1',
      toolName: 'Read',
      input: { file_path: '/repo/src/event-mapper.ts' },
      result: 'export function mapEvent(raw: WireEvent) { … }',
      startAfter: 150,
      runsFor: 250,
    }),
    ...tool({
      id: 'sim-tc-grep',
      toolName: 'Grep',
      input: { pattern: 'Last-Event-ID', path: 'src/' },
      result: 'Found 14 matches',
      startAfter: 150,
      runsFor: 300,
    }),
    ...tool({
      id: 'sim-tc-read-2',
      toolName: 'Read',
      input: { file_path: '/repo/src/session-store.ts' },
      result: 'export const useSessionStore = create(…)',
      startAfter: 150,
      runsFor: 250,
    }),

    // Ten seconds of nothing. Every loop stops; the strip sits still.
    {
      type: 'append_tool_call',
      messageId: MSG,
      toolCall: createToolCall({
        toolCallId: 'sim-tc-glob',
        toolName: 'Glob',
        input: JSON.stringify({ pattern: 'src/**/*.mapper.ts' }),
        status: 'pending',
      }),
      delayMs: 10000,
    },
    {
      type: 'update_tool_call',
      messageId: MSG,
      toolCallId: 'sim-tc-glob',
      patch: { status: 'complete', result: 'src/legacy/event-mapper.ts' },
      delayMs: 400,
    },

    // Burst two: the row is full now, so each arrival pushes the oldest chip
    // into the pile, which wobbles as it lands.
    ...tool({
      id: 'sim-tc-read-3',
      toolName: 'Read',
      input: { file_path: '/repo/src/legacy/event-mapper.ts' },
      result: 'export function mapLegacyEvent(raw) { … }',
      startAfter: 200,
      runsFor: 400,
    }),
    ...tool({
      id: 'sim-tc-read-4',
      toolName: 'Read',
      input: { file_path: '/repo/src/transport.ts' },
      result: 'export interface Transport { … }',
      startAfter: 200,
      runsFor: 400,
    }),

    // The upgrade: the file read at the very start is now being changed. Its
    // chip morphs in place — 📖 flips to ✏️ with a ring pulse — and comes back
    // into the live row, because that is what is happening now.
    ...tool({
      id: 'sim-tc-edit-1',
      toolName: 'Edit',
      input: {
        file_path: '/repo/src/event-mapper.ts',
        old_string: 'function mapEvent(raw: WireEvent) {\n  return legacyMap(raw);\n}',
        new_string:
          'function mapEvent(raw: WireEvent) {\n  const mapped = deriveEvent(raw);\n  assertSeq(mapped);\n  return mapped;\n}',
      },
      result: 'The file /repo/src/event-mapper.ts has been updated.',
      startAfter: 400,
      runsFor: 1200,
    }),
    ...tool({
      id: 'sim-tc-edit-2',
      toolName: 'Edit',
      input: {
        file_path: '/repo/src/event-mapper.ts',
        old_string: 'const RETRY = 3;',
        new_string: 'const RETRY = 5;\nconst BACKOFF_MS = 250;',
      },
      result: 'The file /repo/src/event-mapper.ts has been updated.',
      startAfter: 300,
      runsFor: 900,
    }),

    // A file is created, and the legacy one it replaces is deleted. The `rm`
    // makes two chips: the command that ran, and the file it took.
    ...tool({
      id: 'sim-tc-write',
      toolName: 'Write',
      input: {
        file_path: '/repo/src/derive-event.ts',
        content: 'export function deriveEvent(raw: WireEvent): Event {\n  // …\n}\n',
      },
      result: 'File created successfully at: /repo/src/derive-event.ts',
      startAfter: 400,
      runsFor: 700,
    }),
    ...tool({
      id: 'sim-tc-rm',
      toolName: 'Bash',
      input: { command: 'rm src/legacy/event-mapper.ts' },
      result: '',
      startAfter: 500,
      runsFor: 900,
    }),

    // A batch of links, close together. The two MDN URLs differ only by their
    // fragment, so they fold into one chip counted twice.
    ...tool({
      id: 'sim-tc-fetch-1',
      toolName: 'WebFetch',
      input: { url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/animation#syntax' },
      result: 'The animation shorthand property applies an animation…',
      startAfter: 400,
      runsFor: 1400,
    }),
    ...tool({
      id: 'sim-tc-fetch-2',
      toolName: 'WebFetch',
      input: { url: 'https://developer.mozilla.org/en-US/docs/Web/CSS/animation#examples' },
      result: 'Examples of the animation shorthand…',
      startAfter: 150,
      runsFor: 1600,
    }),
    ...tool({
      id: 'sim-tc-fetch-3',
      toolName: 'WebFetch',
      input: { url: 'https://www.anthropic.com/engineering/streaming' },
      result: 'Streaming responses from the Messages API…',
      startAfter: 150,
      runsFor: 1800,
    }),

    // One command that takes its time: nine seconds of terminal pulse, alone in
    // the row, with everything else already in the pile.
    ...tool({
      id: 'sim-tc-bash',
      toolName: 'Bash',
      input: { command: 'pnpm vitest run src/event-mapper.test.ts' },
      result: '✓ src/event-mapper.test.ts (11 tests) 812ms\n\nTests  11 passed (11)',
      startAfter: 600,
      runsFor: 9000,
    }),

    { type: 'set_streaming', isTextStreaming: true },
    ...buildStreamingTextSteps(MSG, CLOSING_TEXT),
    { type: 'set_streaming', isTextStreaming: false, delayMs: 200 },
    // The turn ends, and the strip settles — once, here, and nowhere else.
    { type: 'update_message', messageId: MSG, patch: { _streaming: false } },
    { type: 'set_status', status: 'idle' },
  ],
};
