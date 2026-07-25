import { useEffect, useState, type ReactNode } from 'react';
import { Users } from 'lucide-react';
import { Badge, Separator } from '@/layers/shared/ui';
import { cn, formatDuration } from '@/layers/shared/lib';
import { useSessionId } from '@/layers/entities/session';
import { useSessionDiagnostics } from '../model/use-session-diagnostics';
import { cacheHitPercent, type SessionDiagnostics } from '../model/session-diagnostics';
import { formatTokens } from '../lib/format-tokens';
import { CopyDiagnosticsButton } from './CopyDiagnosticsButton';
import { UsageDetail, hasRenderableUsage } from './UsageStatusItem';

/** How often the "time since last event" clock ticks while the readout is open. */
const AGE_TICK_MS = 1000;

/**
 * The right panel's Session tab — everything about the session, always, because
 * you opened it on purpose.
 *
 * This is the deliberate opposite of the status line's quiet-by-default rule. The
 * line answers "is anything wrong?" in one glance and the `⋯` panel answers "what
 * is this value?" in two seconds; neither can stay open while you work, and
 * someone watching a stuck stream needs a surface that does. So nothing here is
 * promoted or hidden — it is a readout, not a control panel: no pins, no toggles.
 * Pinning stays in the `⋯` panel, beside the same live value, where the feedback
 * (does it appear in the line?) is one glance away.
 *
 * It shares one hook with that panel ({@link useSessionDiagnostics}), so the two
 * can never report different values for the same session.
 */
export function SessionInspector() {
  const [sessionId] = useSessionId();
  const diagnostics = useSessionDiagnostics(sessionId ?? '');

  if (!sessionId) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center p-6 text-center text-xs">
        Open a session to see what it is doing.
      </div>
    );
  }

  return <SessionReadout diagnostics={diagnostics} />;
}

/**
 * The readout's rendering, split from its data resolution so the dev playground
 * can show it against a mock snapshot without recreating a single row of layout.
 *
 * @param props - The session snapshot to render.
 */
export function SessionReadout({ diagnostics }: { diagnostics: SessionDiagnostics }) {
  return (
    <div
      data-slot="session-inspector"
      className="flex h-full min-w-0 flex-col gap-4 overflow-y-auto p-3"
    >
      <LiveGroup diagnostics={diagnostics} />
      <ResolvedGroup diagnostics={diagnostics} />
      <UsageGroup diagnostics={diagnostics} />
      <SubagentsGroup diagnostics={diagnostics} />
      <div className="mt-auto pt-2">
        <Separator className="mb-2" />
        <CopyDiagnosticsButton diagnostics={diagnostics} className="w-full justify-center" />
      </div>
    </div>
  );
}

/** The stream's own health — the reason this surface stays open. */
function LiveGroup({ diagnostics: d }: { diagnostics: SessionDiagnostics }) {
  const age = useAgeSince(d.lastEventAt);
  const connected = d.connectionState === 'connected';

  return (
    <Group label="Live">
      <Row label="Connection">
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className={cn(
              'inline-block size-1.5 rounded-full',
              connected ? 'bg-green-500' : 'bg-amber-500'
            )}
          />
          {d.connectionState}
        </span>
      </Row>
      <Row label="Turn">{turnLabel(d)}</Row>
      <Row label="Last event">{d.lastEventSeq === 0 ? 'none yet' : `seq ${d.lastEventSeq}`}</Row>
      {/*
        The wire `Last-Event-ID` is `<sessionId>-<serverEpoch>-<seq>` and lives
        only inside the SSE connection (the in-process Obsidian pump has none at
        all), so the honest client-side form of "where is this stream" is the pair
        of cursors this client actually holds: what it resumed from, and how far
        it has got since.
      */}
      <Row label="Resumed from">
        {d.snapshotCursor === null ? 'not hydrated' : `cursor ${d.snapshotCursor}`}
      </Row>
      {/* "Last update", not "last event": the age is measured from the last frame
          this client APPLIED, and a cold snapshot is a frame. Labelling it as an
          event would read as a contradiction beside "Last event — none yet". */}
      <Row label="Last update">{age === null ? '—' : `${formatDuration(age)} ago`}</Row>
      <Row label="Queued messages">{String(d.queueDepth)}</Row>
    </Group>
  );
}

/** What the session actually resolved to, unabbreviated. */
function ResolvedGroup({ diagnostics: d }: { diagnostics: SessionDiagnostics }) {
  return (
    <Group label="Resolved">
      {/* The full path, not the leaf the line shows — this is the surface where
          "which checkout is this?" gets answered. */}
      <Row label="Directory" wrap>
        {d.cwd ?? '—'}
      </Row>
      <Row label="Git">{gitLabel(d)}</Row>
      <Row label="Runtime">{d.runtime ?? '—'}</Row>
      <Row label="Model" wrap>
        {d.model ?? '—'}
      </Row>
      {/* Shown only when it differs from the resolved id: `default` resolving to
          `claude-opus-4-6` is not a mismatch, and repeating one value twice would
          make the readout noisier without saying anything. */}
      {d.selectedModel !== null && d.selectedModel !== d.model && (
        <Row label="Model selected">{d.selectedModel}</Row>
      )}
      <Row label="Effort">{d.effort ?? '—'}</Row>
      <Row label="Fast mode">{d.fastMode ? 'on' : 'off'}</Row>
      <Row label="Permissions">{d.permissionMode}</Row>
      <Row label="Session id" wrap>
        {d.sessionId}
      </Row>
      <Row label="DorkOS version">{d.clientVersion ?? '—'}</Row>
    </Group>
  );
}

/** Context window, prompt cache, and what the session is costing. */
function UsageGroup({ diagnostics: d }: { diagnostics: SessionDiagnostics }) {
  const categories = (d.contextUsage?.categories ?? [])
    .filter((c) => c.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);

  return (
    <Group label="Usage">
      <Row label="Context">{d.contextPercent === null ? '—' : `${d.contextPercent}% full`}</Row>
      {d.contextUsage && (
        <Row label="Tokens">
          {formatTokens(d.contextUsage.totalTokens)} / {formatTokens(d.contextUsage.maxTokens)}
        </Row>
      )}
      {categories.map((category) => (
        <Row
          key={category.name}
          label={category.name}
          indent
          swatch={category.color}
          data-testid={`context-category-${category.name}`}
        >
          {formatTokens(category.tokens)}
        </Row>
      ))}
      {d.cache === null ? (
        <Row label="Cache">nothing cached yet</Row>
      ) : (
        <>
          <Row label="Cache hit">{`${cacheHitPercent(d.cache)}%`}</Row>
          <Row label="Cache read" indent>
            {formatTokens(d.cache.readTokens)}
          </Row>
          <Row label="Cache written" indent>
            {formatTokens(d.cache.creationTokens)}
          </Row>
        </>
      )}
      {d.usage !== null && hasRenderableUsage(d.usage) ? (
        <div className="px-1 pt-1">
          <UsageDetail usage={d.usage} />
        </div>
      ) : (
        <Row label="Usage & cost">no usage reported</Row>
      )}
    </Group>
  );
}

/** Helper agents — what is running now, and what this session could call. */
function SubagentsGroup({ diagnostics: d }: { diagnostics: SessionDiagnostics }) {
  return (
    <Group label="Subagents">
      {d.activeSubagents.length === 0 ? (
        <Row label="Running">none</Row>
      ) : (
        d.activeSubagents.map((subagent) => (
          <div
            key={subagent.taskId}
            data-testid={`active-subagent-${subagent.taskId}`}
            className="space-y-0.5 px-1 py-1"
          >
            <div className="flex items-center gap-2 text-sm">
              <Users className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">
                {subagent.description ?? subagent.taskId}
              </span>
              <Badge variant="secondary" className="shrink-0 text-[10px]">
                {subagent.status}
              </Badge>
            </div>
            <p className="text-muted-foreground pl-5 text-[10px] leading-tight">
              {subagent.toolUses ?? 0} tool{subagent.toolUses === 1 ? '' : 's'}
              {subagent.lastToolName ? ` · last ${subagent.lastToolName}` : ''}
            </p>
          </div>
        ))
      )}
      <Row label="Available">
        {d.subagents.length === 0 ? 'none' : d.subagents.map((a) => a.name).join(', ')}
      </Row>
    </Group>
  );
}

/** One titled section of the readout. */
function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="min-w-0 space-y-0.5">
      <h3 className="text-muted-foreground px-1 pb-1 text-xs font-medium tracking-wide uppercase">
        {label}
      </h3>
      {children}
    </section>
  );
}

/** One label/value line: label left, value right, both allowed to be long. */
function Row({
  label,
  children,
  wrap,
  indent,
  swatch,
  ...rest
}: {
  label: string;
  children: ReactNode;
  /** Let the value break onto more lines instead of truncating (paths, ids). */
  wrap?: boolean;
  /** Nest under the row above it (a breakdown line). */
  indent?: boolean;
  /** Category colour dot, for context-breakdown rows. */
  swatch?: string;
  'data-testid'?: string;
}) {
  return (
    <div
      className={cn('flex items-baseline gap-2 px-1 py-0.5 text-sm', indent && 'pl-4')}
      {...rest}
    >
      {swatch && (
        <span
          aria-hidden
          className="mb-px inline-block size-1.5 shrink-0 self-center rounded-full"
          style={{ backgroundColor: swatch }}
        />
      )}
      <span className={cn('shrink-0', indent ? 'text-muted-foreground text-xs' : '')}>{label}</span>
      <span className="min-w-0 flex-1" />
      <span
        className={cn(
          'text-muted-foreground text-right text-xs',
          wrap ? 'min-w-0 break-all' : 'truncate'
        )}
      >
        {children}
      </span>
    </div>
  );
}

/** Plain-language turn state — the coarse answer plus the honest sub-state. */
function turnLabel(d: SessionDiagnostics): string {
  if (d.triggerPending) return 'sending';
  if (d.streaming) return 'streaming';
  return d.lifecycle ?? 'not hydrated';
}

/** Branch + cleanliness, or the honest absence of a repository. */
function gitLabel(d: SessionDiagnostics): string {
  if (d.gitBranch === null) return 'no repo';
  return d.gitDirty ? `${d.gitBranch} · changed` : `${d.gitBranch} · clean`;
}

/**
 * Milliseconds since `timestamp`, re-read once a second so the readout ages in
 * place. Ticks only while this component is mounted, which is only while the tab
 * is the active one — the container renders no inactive contribution.
 *
 * @param timestamp - `Date.now()` of the last event, or `null` before hydration.
 */
function useAgeSince(timestamp: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (timestamp === null) return;
    const id = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => clearInterval(id);
  }, [timestamp]);
  if (timestamp === null) return null;
  return Math.max(0, now - timestamp);
}
