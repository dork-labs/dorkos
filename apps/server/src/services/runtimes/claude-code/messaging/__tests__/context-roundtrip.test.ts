/**
 * Render ↔ strip round-trip for the runtime-neutral context channel (spec #258,
 * Phase 6 / AC5). The adapter's `renderContextEntry` (the formatter) and the
 * transcript parser's `stripSystemTags` (the render-strip) both key off the
 * shared `CONTEXT_TAG` map. This suite proves they AGREE: for every
 * `ContextKind`, the actual rendered block is fully removed on render, and the
 * pristine user content is preserved — so injected context can never surface as
 * user-authored text. Because both sides iterate `CONTEXT_TAG`, adding a kind
 * needs no edit here beyond a representative sample.
 */
import { describe, it, expect, vi } from 'vitest';

// context-builder.ts pulls these app-wide collaborators at module load; mock
// them so importing `renderContextEntry` doesn't require real wiring (mirrors
// services/core/__tests__/context-builder.test.ts).
vi.mock('../../../../core/git-status.js', () => ({ getGitStatus: vi.fn() }));
vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn() }));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    withTag: vi.fn().mockReturnThis(),
  },
}));
vi.mock('../../../../../lib/version.js', () => ({ SERVER_VERSION: '1.2.3', IS_DEV_BUILD: false }));
vi.mock('../../../../relay/relay-state.js', () => ({ isRelayEnabled: vi.fn(() => true) }));
vi.mock('../../../../tasks/task-state.js', () => ({ isTasksEnabled: vi.fn(() => true) }));

import { renderContextEntry } from '../context-builder.js';
import { stripSystemTags } from '../../sessions/transcript-parser.js';
import { CONTEXT_TAG } from '@dorkos/shared/additional-context';
import type {
  AdditionalContextEntry,
  ContextKind,
  GitStatusData,
} from '@dorkos/shared/additional-context';
import type { UiState } from '@dorkos/shared/types';

const SAMPLE_UI_STATE: UiState = {
  canvas: { open: false, contentType: null },
  panels: { settings: false, tasks: true, relay: false },
  sidebar: { open: true, activeTab: 'sessions' },
  agent: { id: 'agent-1', cwd: '/proj' },
};

const DIRTY_GIT: GitStatusData = {
  isRepo: true,
  branch: 'feature/x',
  ahead: 2,
  behind: 1,
  clean: false,
  modified: 3,
  staged: 1,
  untracked: 4,
  conflicted: 0,
};

/** One representative entry per ContextKind — keyed so the test is exhaustive. */
const SAMPLES: Record<ContextKind, AdditionalContextEntry> = {
  git_status: { kind: 'git_status', scope: 'per-turn', data: DIRTY_GIT },
  ui_state: { kind: 'ui_state', scope: 'per-turn', data: SAMPLE_UI_STATE },
  queue_note: { kind: 'queue_note', scope: 'per-turn', data: { composedDuringPrevTurn: true } },
  env: {
    kind: 'env',
    scope: 'per-session',
    data: {
      workingDirectory: '/proj',
      product: 'DorkOS',
      version: '1.2.3',
      port: 4242,
      platform: 'darwin',
      osVersion: '24.0.0',
      nodeVersion: 'v22.0.0',
      hostname: 'host',
    },
  },
  relay_context: {
    kind: 'relay_context',
    scope: 'per-turn',
    data: {
      agentId: 'agent-1',
      sessionId: 'sess-1',
      from: 'endpoint.a',
      messageId: 'msg-1',
      subject: 'relay.agent.test',
      sent: '2026-06-16T00:00:00.000Z',
    },
  },
};

const ALL_KINDS = Object.keys(CONTEXT_TAG) as ContextKind[];
const USER_TEXT = 'Write a bubble sort with comments.';

describe('renderContextEntry ↔ stripSystemTags round-trip (AC5)', () => {
  it('has a sample for every ContextKind (exhaustive over CONTEXT_TAG)', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...ALL_KINDS].sort());
  });

  it.each(ALL_KINDS)('strips the rendered <%s> block, leaving pristine user text', (kind) => {
    const rendered = renderContextEntry(SAMPLES[kind]);
    const tag = CONTEXT_TAG[kind];

    // The formatter wraps content in the kind's CONTEXT_TAG.
    expect(rendered).toContain(`<${tag}>`);
    expect(rendered).toContain(`</${tag}>`);

    // Prepended to the user message exactly as message-sender does, then parsed
    // for render: the injected block is gone and only the user text remains.
    const persisted = `${rendered}\n\n${USER_TEXT}`;
    const cleaned = stripSystemTags(persisted);

    expect(cleaned).toBe(USER_TEXT);
    expect(cleaned).not.toContain(`<${tag}>`);
    expect(cleaned).not.toContain(`</${tag}>`);
  });

  it('strips a full multi-entry bag (git_status + ui_state + queue_note) to pristine text', () => {
    const bag: AdditionalContextEntry[] = [
      SAMPLES.git_status,
      SAMPLES.ui_state,
      SAMPLES.queue_note,
    ];
    const blocks = bag.map(renderContextEntry).join('\n\n');
    const cleaned = stripSystemTags(`${blocks}\n\n${USER_TEXT}`);

    expect(cleaned).toBe(USER_TEXT);
    for (const tag of Object.values(CONTEXT_TAG)) {
      expect(cleaned).not.toContain(`<${tag}>`);
    }
  });

  it('renders the dirty-tree git block and strips it cleanly', () => {
    const rendered = renderContextEntry(SAMPLES.git_status);
    // Spot-check the formatted body so the round-trip is over real content.
    expect(rendered).toContain('Working tree: dirty (3 modified, 1 staged, 4 untracked)');
    expect(stripSystemTags(`${rendered}\n\n${USER_TEXT}`)).toBe(USER_TEXT);
  });
});
