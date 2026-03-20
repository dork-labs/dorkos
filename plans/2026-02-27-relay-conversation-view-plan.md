---
title: Relay Conversation View Implementation Plan
---

# Relay Conversation View Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform the Relay panel from a raw message log into a human-readable conversation view with bug fixes for payload display and trace loading.

**Architecture:** Server-side conversation grouping endpoint correlates request/response messages, resolves agent names from manifests, and includes payloads from Maildir. Client swaps MessageRow for ConversationRow with progressive disclosure. Trace store is wired into RelayCore.publish().

**Tech Stack:** Express routes, RelayCore (packages/relay), Zod schemas, React 19, TanStack Query, motion/react, Tailwind 4, shadcn/ui

**Design Doc:** `plans/2026-02-27-relay-conversation-view-design.md`

---

### Task 1: Wire TraceStore into RelayCore.publish()

**Files:**

- Modify: `packages/relay/src/types.ts:175-195` (add TraceStoreLike to RelayCore deps)
- Modify: `packages/relay/src/relay-core.ts:247-350` (wire insertSpan after delivery)
- Test: `packages/relay/src/__tests__/relay-core.test.ts`

**Context:**

- TraceStore.insertSpan signature (from `apps/server/src/services/relay/trace-store.ts:68-98`): accepts `{ messageId, traceId, subject, status?, metadata? }`
- RelayCore already has optional deps pattern (adapterRegistry, opts)
- The trace route (`apps/server/src/routes/relay.ts:137-147`) looks up spans by messageId, so traceId should equal messageId for single-message traces

**Step 1: Add TraceStoreLike interface to types.ts**

In `packages/relay/src/types.ts`, add after the `AdapterRegistryLike` interface (~line 213):

```typescript
/** Minimal trace store contract for RelayCore to record delivery spans. */
export interface TraceStoreLike {
  insertSpan(span: {
    messageId: string;
    traceId: string;
    subject: string;
    status?: string;
    metadata?: Record<string, unknown>;
  }): void;
}
```

**Step 2: Add traceStore to RelayCore constructor options**

In `packages/relay/src/relay-core.ts`, add `traceStore?: TraceStoreLike` to the RelayCoreOptions interface and store it as a private field.

**Step 3: Wire insertSpan into publish()**

After the return statement assembly at line ~343 (before the `return {` block), add:

```typescript
// 9. Record trace span for delivery tracking
if (this.traceStore) {
  try {
    this.traceStore.insertSpan({
      messageId,
      traceId: messageId,
      subject,
      status: deliveredTo > 0 ? 'delivered' : 'failed',
      metadata: {
        deliveredTo,
        rejectedCount: rejected.length,
        hasAdapterResult: !!adapterResult,
        durationMs: Date.now() - new Date(envelope.createdAt).getTime(),
      },
    });
  } catch {
    // Trace insertion is best-effort — never fail a publish for tracing
  }
}
```

**Step 4: Write test**

```typescript
it('records trace span when traceStore is provided', async () => {
  const mockTraceStore = { insertSpan: vi.fn() };
  const core = createRelayCore({ traceStore: mockTraceStore });
  // register an endpoint so delivery succeeds
  await core.registerEndpoint('relay.test.subject');
  await core.publish(
    'relay.test.subject',
    { content: 'hello' },
    {
      from: 'relay.test.sender',
      replyTo: 'relay.test.sender',
    }
  );
  expect(mockTraceStore.insertSpan).toHaveBeenCalledWith(
    expect.objectContaining({
      subject: 'relay.test.subject',
      status: 'delivered',
    })
  );
});

it('records failed trace span for dead-lettered messages', async () => {
  const mockTraceStore = { insertSpan: vi.fn() };
  const core = createRelayCore({ traceStore: mockTraceStore });
  await core.publish(
    'relay.nowhere.subject',
    { content: 'lost' },
    {
      from: 'relay.test.sender',
      replyTo: 'relay.test.sender',
    }
  );
  expect(mockTraceStore.insertSpan).toHaveBeenCalledWith(
    expect.objectContaining({
      status: 'failed',
    })
  );
});
```

**Step 5: Run tests**

Run: `pnpm --filter @dorkos/relay exec vitest run`
Expected: All pass including new trace tests

**Step 6: Wire TraceStore in server startup**

In `apps/server/src/index.ts` (or wherever RelayCore is constructed), pass the existing `traceStore` instance to RelayCore's options. Find where `new RelayCore(...)` is called and add `traceStore` to the options object.

**Step 7: Commit**

```bash
git add packages/relay/src/types.ts packages/relay/src/relay-core.ts packages/relay/src/__tests__/relay-core.test.ts apps/server/src/
git commit -m "fix(relay): wire trace store into publish pipeline for delivery tracking"
```

---

### Task 2: Add subject label resolver utility

**Files:**

- Create: `apps/server/src/services/relay/subject-resolver.ts`
- Test: `apps/server/src/services/relay/__tests__/subject-resolver.test.ts`

**Context:**

- Subject patterns: `relay.agent.{sessionId}`, `relay.human.console.{clientId}`, `relay.system.pulse.{scheduleId}`, `relay.system.console`
- Agent resolution: session ID → TranscriptReader.getSession() → cwd → readManifest(cwd) → manifest.name
- TranscriptReader is at `apps/server/src/services/core/transcript-reader.ts`
- readManifest is at `packages/shared/src/manifest.ts`

**Step 1: Write the failing test**

```typescript
import { describe, it, expect, vi } from 'vitest';
import { resolveSubjectLabel, type SubjectLabel } from '../subject-resolver.js';

describe('resolveSubjectLabel', () => {
  it('resolves relay.human.console.* to "You"', async () => {
    const result = await resolveSubjectLabel('relay.human.console.abc-123', {});
    expect(result).toEqual({ label: 'You', raw: 'relay.human.console.abc-123' });
  });

  it('resolves relay.system.console to "System Console"', async () => {
    const result = await resolveSubjectLabel('relay.system.console', {});
    expect(result).toEqual({ label: 'System Console', raw: 'relay.system.console' });
  });

  it('resolves relay.system.pulse.* to "Pulse Scheduler"', async () => {
    const result = await resolveSubjectLabel('relay.system.pulse.sched-1', {});
    expect(result).toEqual({ label: 'Pulse Scheduler', raw: 'relay.system.pulse.sched-1' });
  });

  it('resolves relay.agent.{sessionId} to agent name when available', async () => {
    const mockGetSession = vi.fn().mockResolvedValue({ cwd: '/path/to/project' });
    const mockReadManifest = vi.fn().mockResolvedValue({ name: 'Obsidian Repo' });
    const result = await resolveSubjectLabel('relay.agent.abc-123-def', {
      getSession: mockGetSession,
      readManifest: mockReadManifest,
    });
    expect(result).toEqual({ label: 'Obsidian Repo', raw: 'relay.agent.abc-123-def' });
  });

  it('falls back to truncated session ID when agent not found', async () => {
    const mockGetSession = vi.fn().mockResolvedValue({ cwd: '/path' });
    const mockReadManifest = vi.fn().mockResolvedValue(null);
    const result = await resolveSubjectLabel('relay.agent.abc-123-def', {
      getSession: mockGetSession,
      readManifest: mockReadManifest,
    });
    expect(result).toEqual({ label: 'Agent (abc-123)', raw: 'relay.agent.abc-123-def' });
  });

  it('falls back gracefully when session lookup fails', async () => {
    const mockGetSession = vi.fn().mockRejectedValue(new Error('not found'));
    const result = await resolveSubjectLabel('relay.agent.abc-123-def', {
      getSession: mockGetSession,
    });
    expect(result).toEqual({ label: 'Agent (abc-123)', raw: 'relay.agent.abc-123-def' });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run apps/server/src/services/relay/__tests__/subject-resolver.test.ts`
Expected: FAIL — module not found

**Step 3: Implement subject-resolver.ts**

```typescript
/**
 * Resolve relay subject strings into human-readable labels.
 *
 * @module services/relay/subject-resolver
 */

export interface SubjectLabel {
  label: string;
  raw: string;
}

interface ResolverDeps {
  getSession?: (sessionId: string) => Promise<{ cwd?: string } | null>;
  readManifest?: (cwd: string) => Promise<{ name?: string } | null>;
}

const SESSION_ID_PREVIEW_LENGTH = 7;

/**
 * Resolve a relay subject string into a human-readable label.
 *
 * @param subject - Raw relay subject string
 * @param deps - Optional dependency injection for session/manifest lookup
 */
export async function resolveSubjectLabel(
  subject: string,
  deps: ResolverDeps
): Promise<SubjectLabel> {
  const raw = subject;

  // Static patterns
  if (subject === 'relay.system.console') {
    return { label: 'System Console', raw };
  }
  if (subject.startsWith('relay.system.pulse.')) {
    return { label: 'Pulse Scheduler', raw };
  }
  if (subject.startsWith('relay.human.console.')) {
    return { label: 'You', raw };
  }

  // Agent pattern — resolve name from manifest
  if (subject.startsWith('relay.agent.')) {
    const sessionId = subject.slice('relay.agent.'.length);
    const shortId = sessionId.slice(0, SESSION_ID_PREVIEW_LENGTH);
    const fallback: SubjectLabel = { label: `Agent (${shortId})`, raw };

    if (!deps.getSession) return fallback;

    try {
      const session = await deps.getSession(sessionId);
      if (!session?.cwd || !deps.readManifest) return fallback;

      const manifest = await deps.readManifest(session.cwd);
      if (!manifest?.name) return fallback;

      return { label: manifest.name, raw };
    } catch {
      return fallback;
    }
  }

  // Unknown pattern
  return { label: subject, raw };
}

/**
 * Batch-resolve multiple subjects, deduplicating lookups.
 *
 * @param subjects - Array of raw subject strings
 * @param deps - Dependency injection for session/manifest lookup
 */
export async function resolveSubjectLabels(
  subjects: string[],
  deps: ResolverDeps
): Promise<Map<string, SubjectLabel>> {
  const unique = [...new Set(subjects)];
  const results = await Promise.all(
    unique.map(async (s) => [s, await resolveSubjectLabel(s, deps)] as const)
  );
  return new Map(results);
}
```

**Step 4: Run tests**

Run: `pnpm vitest run apps/server/src/services/relay/__tests__/subject-resolver.test.ts`
Expected: All pass

**Step 5: Commit**

```bash
git add apps/server/src/services/relay/subject-resolver.ts apps/server/src/services/relay/__tests__/subject-resolver.test.ts
git commit -m "feat(relay): add subject label resolver for human-readable names"
```

---

### Task 3: Add GET /relay/conversations endpoint

**Files:**

- Modify: `apps/server/src/routes/relay.ts:55-63` (add new route)
- Modify: `packages/shared/src/relay-schemas.ts` (add ConversationSchema)
- Modify: `packages/shared/src/transport.ts:131-137` (add listRelayConversations)
- Modify: `apps/client/src/layers/shared/lib/http-transport.ts:334-349` (add HTTP call)
- Create: `apps/client/src/layers/entities/relay/model/use-relay-conversations.ts`
- Modify: `apps/client/src/layers/entities/relay/index.ts` (export new hook)

**Context:**

- RelayCore exposes `listMessages()` for SQLite index queries and `getMessage()` for single messages
- Maildir envelopes can be read via RelayCore's internal maildirStore (need to add a public method or read from the endpoint-level data)
- The grouping logic correlates `relay.agent.*` (requests) with `relay.human.console.*` (response chunks)

**Step 1: Add Zod schema in relay-schemas.ts**

Add to `packages/shared/src/relay-schemas.ts`:

```typescript
export const SubjectLabelSchema = z.object({
  label: z.string(),
  raw: z.string(),
});

export const RelayConversationSchema = z.object({
  id: z.string(),
  direction: z.enum(['outbound', 'inbound']),
  status: z.enum(['delivered', 'failed', 'pending']),
  from: SubjectLabelSchema,
  to: SubjectLabelSchema,
  preview: z.string(),
  payload: z.unknown().optional(),
  responseCount: z.number(),
  sentAt: z.string(),
  completedAt: z.string().optional(),
  durationMs: z.number().optional(),
  subject: z.string(),
  sessionId: z.string().optional(),
  clientId: z.string().optional(),
  traceId: z.string().optional(),
  failureReason: z.string().optional(),
});

export type RelayConversation = z.infer<typeof RelayConversationSchema>;
```

**Step 2: Add Transport method**

In `packages/shared/src/transport.ts`, add after `listRelayMessages` (~line 137):

```typescript
/** List relay conversations (grouped request/response exchanges). */
listRelayConversations(): Promise<{ conversations: RelayConversation[] }>;
```

Import the type at the top.

**Step 3: Add HTTP transport implementation**

In `apps/client/src/layers/shared/lib/http-transport.ts`, add after `listRelayMessages`:

```typescript
async listRelayConversations() {
  const res = await this.fetch('/api/relay/conversations');
  return res.json();
},
```

**Step 4: Add server route**

In `apps/server/src/routes/relay.ts`, add after the GET /messages route (~line 63):

```typescript
// GET /conversations — Grouped request/response exchanges with human labels
router.get('/conversations', async (_req, res) => {
  try {
    const messages = relayCore.listMessages({});
    const deadLetters = relayCore.getDeadLetters();

    // Import resolver
    const { resolveSubjectLabels } = await import('../services/relay/subject-resolver.js');
    const { transcriptReader } = await import('../services/core/transcript-reader.js');
    const { readManifest } = await import('@dorkos/shared/manifest');

    // Collect all unique subjects
    const allSubjects = [...messages.messages.map((m: { subject: string }) => m.subject)];
    const resolverDeps = {
      getSession: async (id: string) => transcriptReader.getSession(id),
      readManifest: async (cwd: string) => readManifest(cwd),
    };
    const labelMap = await resolveSubjectLabels(allSubjects, resolverDeps);

    // Separate requests (relay.agent.*) from response chunks (relay.human.console.*)
    const requests: Array<Record<string, unknown>> = [];
    const responseChunksBySubject = new Map<string, Array<Record<string, unknown>>>();

    for (const msg of messages.messages as Array<Record<string, unknown>>) {
      const subject = msg.subject as string;
      if (subject.startsWith('relay.agent.') || subject.startsWith('relay.system.')) {
        requests.push(msg);
      } else if (subject.startsWith('relay.human.console.')) {
        const existing = responseChunksBySubject.get(subject) ?? [];
        existing.push(msg);
        responseChunksBySubject.set(subject, existing);
      }
    }

    // Build conversations from requests
    const conversations = requests.map((req) => {
      const subject = req.subject as string;
      const messageId = req.id as string;
      const status = req.status as string;
      const createdAt = req.createdAt as string;

      // Extract session ID from subject
      const sessionId = subject.startsWith('relay.agent.')
        ? subject.slice('relay.agent.'.length)
        : undefined;

      // Find response chunks (matched by the request's from field being the response subject)
      // For now, use the most recent relay.human.console.* group
      const fromSubject = req.from as string | undefined;
      const responseChunks = fromSubject ? (responseChunksBySubject.get(fromSubject) ?? []) : [];
      const lastChunk = responseChunks[0]; // messages are sorted newest-first

      // Resolve dead letter info
      const deadLetter = deadLetters.find(
        (dl: { messageId: string }) => dl.messageId === messageId
      );

      // Build preview from dead letter envelope (has full payload) or from the message
      let preview = '';
      let payload: unknown = undefined;
      if (deadLetter?.envelope?.payload) {
        payload = deadLetter.envelope.payload;
        const p = payload as Record<string, unknown>;
        const text = p?.content ?? p?.text ?? p?.message;
        preview =
          typeof text === 'string' ? text.slice(0, 120) : JSON.stringify(payload).slice(0, 120);
      }

      const fromLabel = labelMap.get(fromSubject ?? '') ?? {
        label: 'Unknown',
        raw: fromSubject ?? '',
      };
      const toLabel = labelMap.get(subject) ?? { label: subject, raw: subject };

      return {
        id: messageId,
        direction: 'outbound' as const,
        status:
          status === 'cur' || status === 'delivered'
            ? ('delivered' as const)
            : status === 'failed'
              ? ('failed' as const)
              : ('pending' as const),
        from: fromLabel,
        to: toLabel,
        preview,
        payload,
        responseCount: responseChunks.length,
        sentAt: createdAt,
        completedAt: lastChunk?.createdAt as string | undefined,
        durationMs: lastChunk
          ? new Date(lastChunk.createdAt as string).getTime() - new Date(createdAt).getTime()
          : undefined,
        subject,
        sessionId,
        traceId: messageId,
        failureReason: deadLetter?.reason as string | undefined,
      };
    });

    return res.json({ conversations });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to build conversations';
    return res.status(500).json({ error: message });
  }
});
```

**Step 5: Add client hook**

Create `apps/client/src/layers/entities/relay/model/use-relay-conversations.ts`:

```typescript
import { useQuery } from '@tanstack/react-query';
import { useTransport } from '@/layers/shared/model';
import type { RelayConversation } from '@dorkos/shared/relay-schemas';

export const RELAY_CONVERSATIONS_KEY = ['relay', 'conversations'] as const;

/** Fetch grouped relay conversations with human-readable labels. */
export function useRelayConversations(enabled = true) {
  const transport = useTransport();
  return useQuery<{ conversations: RelayConversation[] }>({
    queryKey: [...RELAY_CONVERSATIONS_KEY],
    queryFn: () => transport.listRelayConversations(),
    enabled,
    refetchInterval: 5000,
  });
}
```

**Step 6: Export from barrel**

In `apps/client/src/layers/entities/relay/index.ts`, add:

```typescript
export { useRelayConversations } from './model/use-relay-conversations';
```

**Step 7: Run typecheck**

Run: `pnpm typecheck`
Expected: Clean across all packages

**Step 8: Commit**

```bash
git add packages/shared/src/relay-schemas.ts packages/shared/src/transport.ts apps/client/src/layers/shared/lib/http-transport.ts apps/server/src/routes/relay.ts apps/client/src/layers/entities/relay/
git commit -m "feat(relay): add conversations endpoint with grouped messages and human labels"
```

---

### Task 4: Create ConversationRow component

**Files:**

- Create: `apps/client/src/layers/features/relay/ui/ConversationRow.tsx`
- Modify: `apps/client/src/layers/features/relay/ui/ActivityFeed.tsx` (swap MessageRow for ConversationRow)

**Context:**

- Current MessageRow is at `apps/client/src/layers/features/relay/ui/MessageRow.tsx` (158 lines)
- Uses motion/react for expand/collapse, Badge from shared/ui, MessageTrace for trace view
- Status colors from `../lib/status-colors.ts`
- Design: collapsed shows "You → Agent Name", preview, status. Expanded shows payload, delivery timing, technical accordion, trace accordion.

**Step 1: Create ConversationRow.tsx**

```typescript
import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Check,
  AlertTriangle,
  Clock,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { Badge } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { MessageTrace } from './MessageTrace';
import { getStatusBorderColor } from '../lib/status-colors';
import type { RelayConversation } from '@dorkos/shared/relay-schemas';

interface ConversationRowProps {
  conversation: RelayConversation;
}

const STATUS_CONFIG = {
  delivered: { icon: Check, className: 'text-green-600 dark:text-green-400', label: 'Delivered', dot: 'bg-green-500' },
  failed: { icon: AlertTriangle, className: 'text-destructive', label: 'Failed', dot: 'bg-red-500' },
  pending: { icon: Clock, className: 'text-muted-foreground', label: 'Pending', dot: 'bg-blue-500' },
} as const;

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Conversation card with progressive disclosure: human labels → payload → technical details. */
export function ConversationRow({ conversation }: ConversationRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [showTechnical, setShowTechnical] = useState(false);
  const [showTrace, setShowTrace] = useState(false);

  const config = STATUS_CONFIG[conversation.status];
  const borderColor = getStatusBorderColor(conversation.status);

  const outcome = conversation.status === 'delivered'
    ? conversation.responseCount > 0
      ? `delivered · ${conversation.responseCount} chunks`
      : 'delivered'
    : conversation.failureReason ?? config.label.toLowerCase();

  return (
    <div
      className={cn(
        'w-full rounded-lg border border-l-2 text-left transition-colors hover:bg-muted/50 hover:shadow-sm',
        borderColor,
        expanded && 'bg-muted/30',
      )}
    >
      {/* Collapsed view — human-readable only */}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full p-3"
      >
        <div className="flex items-center gap-2">
          <span className={cn('size-2 shrink-0 rounded-full', config.dot)} />
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {conversation.from.label}
            <span className="mx-1.5 text-muted-foreground">→</span>
            {conversation.to.label}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {formatTimeAgo(conversation.sentAt)}
          </span>
        </div>
        <div className="mt-1 flex items-center gap-2">
          {conversation.preview && (
            <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
              "{conversation.preview}"
            </span>
          )}
          <span className={cn('shrink-0 text-xs', config.className)}>
            {outcome}
          </span>
        </div>
      </button>

      {/* Expanded view — payload + delivery details */}
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="space-y-3 border-t px-3 pb-3 pt-3">
              {/* Payload */}
              {conversation.payload != null && (
                <div>
                  <span className="text-xs font-medium text-muted-foreground">Payload</span>
                  <pre className="mt-1 max-h-40 overflow-auto rounded bg-muted p-2 font-mono text-xs">
                    {JSON.stringify(conversation.payload, null, 2)}
                  </pre>
                </div>
              )}

              {/* Delivery timing */}
              <div className="text-xs text-muted-foreground">
                <span>Sent {formatTime(conversation.sentAt)}</span>
                {conversation.completedAt && (
                  <span> · Completed {formatTime(conversation.completedAt)}</span>
                )}
                {conversation.durationMs != null && (
                  <span> · Duration: {formatDuration(conversation.durationMs)}</span>
                )}
                {conversation.responseCount > 0 && (
                  <span> · {conversation.responseCount} response chunks</span>
                )}
              </div>

              {/* Failure reason */}
              {conversation.failureReason && (
                <div className="rounded bg-destructive/10 px-2 py-1 text-xs text-destructive">
                  {conversation.failureReason}
                </div>
              )}

              {/* Technical Details accordion */}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setShowTechnical(!showTechnical); }}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                {showTechnical ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                Technical Details
              </button>
              <AnimatePresence initial={false}>
                {showTechnical && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="overflow-hidden"
                  >
                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                      <dt className="text-muted-foreground">Subject</dt>
                      <dd className="truncate font-mono">{conversation.subject}</dd>
                      {conversation.sessionId && (
                        <>
                          <dt className="text-muted-foreground">Session</dt>
                          <dd className="font-mono">{conversation.sessionId.slice(0, 8)}</dd>
                        </>
                      )}
                      {conversation.traceId && (
                        <>
                          <dt className="text-muted-foreground">Trace ID</dt>
                          <dd className="font-mono">{conversation.traceId.slice(0, 12)}…</dd>
                        </>
                      )}
                      <dt className="text-muted-foreground">From (raw)</dt>
                      <dd className="truncate font-mono">{conversation.from.raw}</dd>
                      <dt className="text-muted-foreground">To (raw)</dt>
                      <dd className="truncate font-mono">{conversation.to.raw}</dd>
                    </dl>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Trace Timeline accordion */}
              {conversation.traceId && (
                <>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setShowTrace(!showTrace); }}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
                  >
                    {showTrace ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
                    Trace Timeline
                  </button>
                  <AnimatePresence initial={false}>
                    {showTrace && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        className="overflow-hidden"
                      >
                        <MessageTrace messageId={conversation.traceId} onClose={() => setShowTrace(false)} />
                      </motion.div>
                    )}
                  </AnimatePresence>
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
```

**Step 2: Swap MessageRow for ConversationRow in ActivityFeed**

In `apps/client/src/layers/features/relay/ui/ActivityFeed.tsx`:

1. Replace `import { MessageRow } from './MessageRow'` with `import { ConversationRow } from './ConversationRow'`
2. Replace `useRelayMessages` with `useRelayConversations` from the entities barrel
3. Replace the MessageRow render loop with ConversationRow, passing `conversation` prop
4. Update the filter logic to work on `RelayConversation` fields instead of raw message fields
5. Keep the existing animation logic (initialIdsRef, motion.div wrapper)

The source filter maps to conversation fields:

- "Chat messages" → `conversation.subject.startsWith('relay.agent.')`
- "Pulse jobs" → `conversation.subject.startsWith('relay.system.pulse.')`
- "System" → `conversation.subject.startsWith('relay.system.') && !conversation.subject.startsWith('relay.system.pulse.')`

The status filter maps directly to `conversation.status`.

The search filter matches against `conversation.from.label`, `conversation.to.label`, `conversation.preview`, or `conversation.subject`.

**Step 3: Run typecheck and dev server**

Run: `pnpm typecheck`
Then: `pnpm dev` and verify in browser

**Step 4: Commit**

```bash
git add apps/client/src/layers/features/relay/ui/ConversationRow.tsx apps/client/src/layers/features/relay/ui/ActivityFeed.tsx
git commit -m "feat(relay): replace MessageRow with ConversationRow for human-readable activity feed"
```

---

### Task 5: Improve DeadLetterSection with human labels

**Files:**

- Modify: `apps/client/src/layers/features/relay/ui/DeadLetterSection.tsx`

**Context:**

- Dead letter API response already includes the full envelope with payload and subject
- Current DeadLetterRow shows message ID and reason, but no human-readable info
- The dead letter data has `envelope.subject`, `envelope.payload`, `envelope.from`

**Step 1: Update DeadLetterRow to show human labels**

In `DeadLetterSection.tsx`, update the `DeadLetterRow` component:

1. Extract preview from `dl.envelope.payload.content` (or fallback to JSON preview)
2. Parse the target from `dl.envelope.subject` using the same static label patterns (client-side is fine here since we already have the full envelope):
   - `relay.agent.{id}` → `Agent ({id.slice(0,7)})`
   - `relay.system.pulse.*` → `Pulse Scheduler`
   - etc.
3. Show preview text + target label instead of hash ID
4. Keep the failure reason badge
5. Keep the expandable JSON detail for power users

The collapsed row should show:

```
"hello" → Agent (a6010b)    No matching endpoints    4h ago
```

Instead of:

```
01KJG7Z6ZQAFXRTMB1WQKS1MQM    Unknown    4h ago
```

**Step 2: Run dev server and verify**

**Step 3: Commit**

```bash
git add apps/client/src/layers/features/relay/ui/DeadLetterSection.tsx
git commit -m "feat(relay): show human-readable labels and message preview in dead letters"
```

---

### Task 6: Improve EndpointList with human labels

**Files:**

- Modify: `apps/client/src/layers/features/relay/ui/EndpointList.tsx`

**Context:**

- Endpoint data includes `subject`, `hash`, `registeredAt`
- Apply the same static subject parsing client-side
- Show human label as primary text, raw subject as secondary monospace

**Step 1: Add a client-side label resolver**

Create a small utility in `apps/client/src/layers/features/relay/lib/resolve-label.ts`:

```typescript
/** Resolve a relay subject to a human-friendly label (client-side, no server calls). */
export function resolveSubjectLabelLocal(subject: string): string {
  if (subject === 'relay.system.console') return 'System Console';
  if (subject.startsWith('relay.system.pulse.')) return 'Pulse Scheduler';
  if (subject.startsWith('relay.human.console.')) return 'Your Browser Session';
  if (subject.startsWith('relay.agent.')) {
    const id = subject.slice('relay.agent.'.length);
    return `Agent (${id.slice(0, 7)})`;
  }
  return subject;
}
```

**Step 2: Update EndpointList to show human label above raw subject**

In the endpoint card, render:

- Human label as `text-sm font-medium`
- Raw subject below as `text-xs font-mono text-muted-foreground truncate`

**Step 3: Update AdapterCard description**

In `AdapterCard.tsx`, for the Claude Code adapter, replace "In: N | Out: N" with a more descriptive line like "Handles: Chat messages, Pulse jobs" when the adapter's subject prefixes are `relay.agent.*` and `relay.system.pulse.*`.

**Step 4: Run dev server and verify**

**Step 5: Commit**

```bash
git add apps/client/src/layers/features/relay/lib/resolve-label.ts apps/client/src/layers/features/relay/ui/EndpointList.tsx apps/client/src/layers/features/relay/ui/AdapterCard.tsx
git commit -m "feat(relay): add human-readable labels to endpoints and adapter descriptions"
```

---

### Task 7: Update filter labels and search placeholder

**Files:**

- Modify: `apps/client/src/layers/features/relay/ui/ActivityFeed.tsx`

**Context:**

- Current source filter options: derived from subject prefixes with technical names
- Current search placeholder: "Filter by subject..."

**Step 1: Update filter labels**

Rename source filter options:

- "All" stays
- TG/Telegram → (keep if present)
- WH/Webhook → (keep if present)
- SYS → "System"
- Add "Chat" for `relay.agent.*` and `relay.human.console.*`

Rename status filter options:

- "All" stays
- "New" → "Pending"
- "Cur" → "Delivered"
- "Failed" stays
- "Dead Letter" → "Failed"

Update search placeholder: `"Filter by agent or message..."`

**Step 2: Verify in browser**

**Step 3: Commit**

```bash
git add apps/client/src/layers/features/relay/ui/ActivityFeed.tsx
git commit -m "feat(relay): rename filter labels to human-friendly terms"
```

---

### Task 8: Final integration test and cleanup

**Files:**

- Modify: `apps/client/src/layers/features/relay/ui/MessageRow.tsx` (keep but no longer imported by ActivityFeed — verify unused or remove)
- Run: Full test suite

**Step 1: Run full test suite**

Run: `pnpm test -- --run`
Expected: All pass

**Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: Clean

**Step 3: Run lint**

Run: `pnpm lint`
Expected: No new errors

**Step 4: Manual browser verification**

Start dev server (`pnpm dev`), open Relay panel:

- [ ] Activity tab shows ConversationRow with "You → Agent Name" labels
- [ ] Expanding a conversation shows payload (not "undefined")
- [ ] Expanding a conversation shows delivery timing
- [ ] Technical Details accordion shows raw subjects
- [ ] Trace Timeline accordion loads (not "Failed to load trace")
- [ ] Dead letters show message preview and target name
- [ ] Endpoints show human labels above raw subjects
- [ ] Filters use friendly labels
- [ ] Send a test message via Compose and verify the full flow

**Step 5: Remove MessageRow if unused**

If MessageRow is no longer imported anywhere, remove it to avoid dead code. Check with grep first.

**Step 6: Final commit**

```bash
git add -A
git commit -m "feat(relay): complete conversation view with human labels, payload display, and trace fixes"
```
