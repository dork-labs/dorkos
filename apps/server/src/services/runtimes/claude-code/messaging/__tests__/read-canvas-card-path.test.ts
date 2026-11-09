/**
 * DOR-4060: Claude Code's own card for `read_canvas_document` names the file the
 * call would read, not just the document id, so a person sees what they allow.
 */
import { describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  CanvasDocumentStore,
  CanvasService,
  sessionScope,
  setCanvasService,
} from '../../../../canvas/index.js';
import { handleToolApproval } from '../interactive-handlers.js';
import type { InteractiveSession, PendingInteraction } from '../interaction-wait.js';

describe('the read_canvas_document card', () => {
  it('names the file the document reads', () => {
    const canvas = new CanvasService({
      documents: new CanvasDocumentStore(createTestDb()),
      channels: { publish: () => {}, viewers: () => 0 },
    });
    setCanvasService(canvas);
    const applied = canvas.apply({
      scope: sessionScope('sdk-4060'),
      authorId: 'agent',
      command: { action: 'open_file', sourcePath: 'notes/plan.md' },
      tree: { resolvedCwd: '/agents/qa', sourceLabel: null, treeKind: null, aheadOfMain: null },
      defaultTarget: 'active-in-view',
    });
    if (!applied.applied) throw new Error(applied.reason);
    const session: InteractiveSession = {
      sdkSessionId: 'sdk-4060',
      pendingInteractions: new Map<string, PendingInteraction>(),
      eventQueue: [] as StreamEvent[],
      eventQueueNotify: vi.fn(),
    };

    void handleToolApproval(
      session,
      'call-1',
      'mcp__dorkos__read_canvas_document',
      { documentId: applied.documentId },
      { signal: new AbortController().signal, toolUseID: 'call-1' }
    );

    expect(session.eventQueue[0]).toMatchObject({
      type: 'approval_required',
      data: { blockedPath: '/agents/qa/notes/plan.md' },
    });
  });

  it('leaves every other tool’s card as it was', () => {
    const session: InteractiveSession = {
      pendingInteractions: new Map<string, PendingInteraction>(),
      eventQueue: [] as StreamEvent[],
      eventQueueNotify: vi.fn(),
    };
    void handleToolApproval(
      session,
      'call-2',
      'Bash',
      { command: 'ls' },
      {
        signal: new AbortController().signal,
        toolUseID: 'call-2',
      }
    );
    expect(
      (session.eventQueue[0] as { data: { blockedPath?: string } }).data.blockedPath
    ).toBeUndefined();
  });
});
