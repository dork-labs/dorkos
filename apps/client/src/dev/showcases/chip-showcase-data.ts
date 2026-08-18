/**
 * Fixtures for the touch-chip showcases: one chip per verb in every state, a
 * roster big enough to need the tray's filters, and a turn's worth of tool calls
 * for the strip to fold on its own.
 *
 * Split out of `ChipShowcases.tsx` so that file is the showcases themselves.
 *
 * @module dev/showcases/chip-showcase-data
 */
import type { MessagePart } from '@dorkos/shared/types';
import type { TouchChip as TouchChipData } from '@/layers/features/chat/lib/touch-chips';

/** Build one chip model, with the fields every chip needs already filled in. */
function chip(overrides: Partial<TouchChipData> & Pick<TouchChipData, 'key'>): TouchChipData {
  return {
    kind: 'file',
    label: 'session-store.ts',
    fullTarget: '/repo/src/session-store.ts',
    verb: 'read',
    live: false,
    error: false,
    touches: 1,
    firstSeq: 0,
    lastSeq: 0,
    history: ['read'],
    ...overrides,
  };
}

/** The tombstone, kept by name so nothing has to go looking for it in a list. */
export const DELETED_CHIP: TouchChipData = chip({
  key: 'delete',
  verb: 'delete',
  label: 'legacy-mapper.ts',
  fullTarget: '/repo/src/legacy-mapper.ts',
  history: ['deleted'],
});

/**
 * One chip per verb, in the canonical reading order, each carrying the settled
 * anatomy the design record gives it: a repeat count, a diffstat, a hit count.
 */
export const VERB_CHIPS: TouchChipData[] = [
  chip({ key: 'read', verb: 'read', touches: 2, history: ['read', 'read'] }),
  chip({
    key: 'search',
    verb: 'search',
    kind: 'command',
    label: '"Last-Event-ID"',
    fullTarget: 'Last-Event-ID',
    hits: 14,
    history: ['searched (14 hits)'],
  }),
  chip({
    key: 'edit',
    verb: 'edit',
    label: 'event-mapper.ts',
    fullTarget: '/repo/src/event-mapper.ts',
    additions: 12,
    deletions: 4,
    history: ['edited +12 −4'],
  }),
  chip({
    key: 'create',
    verb: 'create',
    label: 'use-touch-chips.ts',
    fullTarget: '/repo/src/use-touch-chips.ts',
    additions: 86,
    history: ['created +86'],
  }),
  DELETED_CHIP,
  chip({
    key: 'fetch',
    verb: 'fetch',
    kind: 'url',
    label: 'anthropic.com',
    fullTarget: 'https://anthropic.com/engineering',
    history: ['fetched'],
  }),
  chip({
    key: 'run',
    verb: 'run',
    kind: 'command',
    label: 'pnpm vitest run',
    fullTarget: 'pnpm vitest run',
    history: ['ran'],
  }),
];

/** The same seven, mid-flight: this is what the verb signatures animate. */
export const LIVE_VERB_CHIPS: TouchChipData[] = VERB_CHIPS.map((entry) => ({
  ...entry,
  live: true,
}));

/** A read that failed and an edit that failed — the destructive tint, twice. */
export const ERROR_CHIPS: TouchChipData[] = [
  chip({ key: 'err-read', error: true, history: ['read'] }),
  chip({
    key: 'err-edit',
    verb: 'edit',
    label: 'event-mapper.ts',
    fullTarget: '/repo/src/event-mapper.ts',
    additions: 3,
    deletions: 1,
    error: true,
    history: ['edited +3 −1'],
  }),
];

/** A file that was read twice and then changed: the chip that morphed in place. */
export const UPGRADED_CHIP: TouchChipData = chip({
  key: 'upgraded',
  verb: 'edit',
  label: 'schemas.ts',
  fullTarget: '/repo/src/schemas.ts',
  touches: 3,
  additions: 12,
  deletions: 4,
  upgraded: true,
  history: ['read', 'read', 'edited +12 −4'],
});

/** A glob: a chip that names many files, so there is nothing single to open. */
export const PATTERN_CHIP: TouchChipData = chip({
  key: 'pattern',
  label: 'src/**/*.ts',
  fullTarget: 'src/**/*.ts',
  pattern: true,
  history: ['globbed'],
});

/** Names for a roster big enough to need the tray's filters. */
const ROSTER_FILES = [
  'session-store.ts',
  'event-mapper.ts',
  'transport.ts',
  'use-chat-session.ts',
  'Timeline.tsx',
  'chip-motion.ts',
  'touch-chips.ts',
  'agent-runtime.ts',
];

/** A turn that touched a lot: eight files, two searches, two links, two commands. */
export const ROSTER: TouchChipData[] = [
  ...ROSTER_FILES.map((name, index) =>
    chip({
      key: `roster-file-${index}`,
      label: name,
      fullTarget: `/repo/src/${name}`,
      verb: index % 4 === 0 ? 'edit' : 'read',
      touches: (index % 3) + 1,
      additions: index % 4 === 0 ? 6 + index : undefined,
      deletions: index % 4 === 0 ? index : undefined,
      firstSeq: index,
      lastSeq: index,
      history: ['read'],
    })
  ),
  chip({
    key: 'roster-search-1',
    verb: 'search',
    kind: 'command',
    label: '"Last-Event-ID"',
    fullTarget: 'Last-Event-ID',
    hits: 14,
    firstSeq: 8,
    lastSeq: 8,
    history: ['searched (14 hits)'],
  }),
  chip({
    key: 'roster-search-2',
    verb: 'search',
    kind: 'command',
    label: '"accumulate"',
    fullTarget: 'accumulate',
    hits: 1,
    firstSeq: 9,
    lastSeq: 9,
    history: ['searched (1 hit)'],
  }),
  chip({
    key: 'roster-create',
    verb: 'create',
    label: 'use-touch-chips.ts',
    fullTarget: '/repo/src/use-touch-chips.ts',
    additions: 86,
    firstSeq: 10,
    lastSeq: 10,
    history: ['created +86'],
  }),
  chip({
    key: 'roster-delete',
    verb: 'delete',
    label: 'legacy-mapper.ts',
    fullTarget: '/repo/src/legacy-mapper.ts',
    firstSeq: 11,
    lastSeq: 11,
    history: ['deleted'],
  }),
  chip({
    key: 'roster-fetch-1',
    verb: 'fetch',
    kind: 'url',
    label: 'anthropic.com',
    fullTarget: 'https://anthropic.com/engineering',
    touches: 2,
    firstSeq: 12,
    lastSeq: 12,
    history: ['fetched', 'fetched'],
  }),
  chip({
    key: 'roster-fetch-2',
    verb: 'fetch',
    kind: 'url',
    label: 'developer.mozilla.org',
    fullTarget: 'https://developer.mozilla.org/en-US/docs/Web/CSS/animation',
    firstSeq: 13,
    lastSeq: 13,
    history: ['fetched'],
  }),
  chip({
    key: 'roster-run-1',
    verb: 'run',
    kind: 'command',
    label: 'pnpm vitest run',
    fullTarget: 'pnpm vitest run',
    firstSeq: 14,
    lastSeq: 14,
    history: ['ran'],
  }),
  chip({
    key: 'roster-run-2',
    verb: 'run',
    kind: 'command',
    label: 'git status --short',
    fullTarget: 'git status --short',
    firstSeq: 15,
    lastSeq: 15,
    history: ['ran'],
  }),
];

/** A turn's worth of tool calls, for the strip to fold on its own. */
function toolCall(
  toolName: string,
  input: unknown,
  options: { result?: string; status?: 'running' | 'complete' | 'error' } = {}
): MessagePart {
  return {
    type: 'tool_call',
    toolCallId: `showcase-${toolName}-${JSON.stringify(input)}`,
    toolName,
    input: JSON.stringify(input),
    result: options.result,
    status: options.status ?? 'complete',
  };
}

/** The parts a working turn has produced so far — the strip's live state. */
export const WORKING_PARTS: MessagePart[] = [
  toolCall('Read', { file_path: '/repo/src/session-store.ts' }),
  toolCall('Grep', { pattern: 'Last-Event-ID' }, { result: 'Found 14 matches' }),
  toolCall('Read', { file_path: '/repo/src/event-mapper.ts' }),
  toolCall('Read', { file_path: '/repo/src/transport.ts' }),
  toolCall('Edit', {
    file_path: '/repo/src/event-mapper.ts',
    old_string: 'a\nb\nc',
    new_string: 'a\nX\nY\nZ',
  }),
  toolCall('Bash', { command: 'pnpm vitest run' }, { status: 'running' }),
];

/**
 * The same turn, finished — every tool settled, so the strip collapses.
 *
 * Its tool ids are re-namespaced rather than shared with {@link WORKING_PARTS}.
 * A strip files its tray state under the turn's first tool id (see
 * `trayExpansionKey`), and these two turns stand side by side on one page, so
 * sharing ids would mean opening one tray opened the other.
 */
export const SETTLED_PARTS: MessagePart[] = WORKING_PARTS.map((part) =>
  part.type === 'tool_call'
    ? { ...part, toolCallId: `settled-${part.toolCallId}`, status: 'complete' as const }
    : part
);
