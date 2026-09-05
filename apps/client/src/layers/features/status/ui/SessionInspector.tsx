import { useEffect, useState, type ReactNode } from 'react';
import { Users } from 'lucide-react';
import { Badge, DetailRow, Separator } from '@/layers/shared/ui';
import { cn, formatDuration } from '@/layers/shared/lib';
import { useAppStore } from '@/layers/shared/model';
import { useSessionId } from '@/layers/entities/session';
// UI composition (allowed cross-feature): the session's connector surface is
// the connections feature's component; this readout only hosts it.
import { SessionConnectorsGroup } from '@/layers/features/connections';
import { useSessionDiagnostics } from '../model/use-session-diagnostics';
import {
  cacheHitPercent,
  type ActiveSubagent,
  type GitDiagnostics,
  type SessionDiagnostics,
} from '../model/session-diagnostics';
import { formatTokens } from '../lib/format-tokens';
import { partitionSubagents } from '../lib/fold-active-subagents';
import { CONNECTION_STATE_CONFIG } from './ConnectionItem';
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
  // Whether this readout is actually on screen, which mounting does NOT imply:
  // the container renders the active tab's content unconditionally and collapses
  // the desktop Panel to zero width, so a closed panel leaves the active tab
  // mounted and invisible. The overlay/mobile variant returns null when closed,
  // so the same flag is exactly right there too.
  const visible = useAppStore((s) => s.rightPanelOpen);

  if (!sessionId) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center p-6 text-center text-xs">
        Open a session to see what it is doing.
      </div>
    );
  }

  return (
    <SessionReadout
      diagnostics={diagnostics}
      live={visible}
      connectors={<SessionConnectorsGroup sessionId={sessionId} />}
    />
  );
}

/**
 * The readout's rendering, split from its data resolution so the dev playground
 * can show it against a mock snapshot without recreating a single row of layout.
 *
 * @param props - The session snapshot to render, and whether it is on screen.
 * @param props.diagnostics - The session snapshot to render.
 * @param props.live - Whether the readout is visible, gating the one-second age
 *   tick. Defaults to `true` for static hosts (the playground) that only ever
 *   render it when it is on screen.
 * @param props.connectors - The session's connector surface (attached
 *   accounts, attach/detach), injected as a slot so this layout stays
 *   renderable against a mock snapshot (playground) with no live queries.
 */
export function SessionReadout({
  diagnostics,
  live = true,
  connectors,
}: {
  diagnostics: SessionDiagnostics;
  live?: boolean;
  connectors?: ReactNode;
}) {
  return (
    <div
      data-slot="session-inspector"
      className="flex h-full min-w-0 flex-col gap-4 overflow-y-auto p-3"
    >
      <LiveGroup diagnostics={diagnostics} live={live} />
      <ResolvedGroup diagnostics={diagnostics} />
      <UsageGroup diagnostics={diagnostics} />
      <SubagentsGroup diagnostics={diagnostics} />
      {connectors}
      <div className="mt-auto pt-2">
        <Separator className="mb-2" />
        <CopyDiagnosticsButton diagnostics={diagnostics} className="w-full justify-center" />
      </div>
    </div>
  );
}

/** The stream's own health — the reason this surface stays open. */
function LiveGroup({ diagnostics: d, live }: { diagnostics: SessionDiagnostics; live: boolean }) {
  const age = useAgeSince(d.lastEventAt, live);
  // Colour and words from the same map the status line's item reads — the surface
  // built to diagnose a dropped connection must not be the one that under-reports
  // it (see `CONNECTION_STATE_CONFIG`).
  const connection = CONNECTION_STATE_CONFIG[d.connectionState];

  return (
    <Group label="Live">
      <DetailRow label="Live updates">
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className={cn(
              'inline-block size-1.5 rounded-full',
              connection.color,
              connection.tasks && 'animate-breath'
            )}
          />
          {/* shortLabel, not label: the row label already says "Live updates",
              so the disconnected state's full label ("Live updates lost")
              would stutter it right back — "Offline" says the same thing
              without repeating the row's own word. */}
          {connection.shortLabel}
        </span>
      </DetailRow>
      <DetailRow label="Turn">{turnLabel(d)}</DetailRow>
      <DetailRow label="Last event">
        {d.lastEventSeq === 0 ? 'none yet' : `seq ${d.lastEventSeq}`}
      </DetailRow>
      {/*
        The wire `Last-Event-ID` is `<sessionId>-<serverEpoch>-<seq>` and lives
        only inside the SSE connection (the in-process Obsidian pump has none at
        all), so the honest client-side form of "where is this stream" is the pair
        of cursors this client actually holds: what it resumed from, and how far
        it has got since.
      */}
      <DetailRow label="Resumed from">
        {d.snapshotCursor === null ? 'not hydrated' : `cursor ${d.snapshotCursor}`}
      </DetailRow>
      {/* "Last update", not "last event": the age is measured from the last frame
          this client APPLIED, and a cold snapshot is a frame. Labelling it as an
          event would read as a contradiction beside "Last event — none yet". */}
      <DetailRow label="Last update">{age === null ? '—' : `${formatDuration(age)} ago`}</DetailRow>
      <DetailRow label="Queued messages">{String(d.queueDepth)}</DetailRow>
    </Group>
  );
}

/** What the session actually resolved to, unabbreviated. */
function ResolvedGroup({ diagnostics: d }: { diagnostics: SessionDiagnostics }) {
  return (
    <Group label="Resolved">
      {/* The full path, not the leaf the line shows — this is the surface where
          "which checkout is this?" gets answered. */}
      <DetailRow label="Directory" wrap>
        {d.cwd ?? '—'}
      </DetailRow>
      <DetailRow label="Git">{gitLabel(d.git)}</DetailRow>
      <DetailRow label="Runtime">{d.runtime ?? '—'}</DetailRow>
      <DetailRow label="Model" wrap>
        {d.model ?? '—'}
      </DetailRow>
      {/* Shown only when it differs from the resolved id: `default` resolving to
          `claude-opus-4-6` is not a mismatch, and repeating one value twice would
          make the readout noisier without saying anything. */}
      {d.selectedModel !== null && d.selectedModel !== d.model && (
        <DetailRow label="Model selected">{d.selectedModel}</DetailRow>
      )}
      <DetailRow label="Effort">{d.effort ?? '—'}</DetailRow>
      <DetailRow label="Fast mode">{d.fastMode ? 'on' : 'off'}</DetailRow>
      <DetailRow label="Permissions">{d.permissionMode}</DetailRow>
      <DetailRow label="Session id" wrap>
        {d.sessionId}
      </DetailRow>
      <DetailRow label="DorkOS version">{d.clientVersion ?? '—'}</DetailRow>
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
      <DetailRow label="Context">
        {d.contextPercent === null ? '—' : `${d.contextPercent}% full`}
      </DetailRow>
      {d.contextUsage && (
        <DetailRow label="Tokens">
          {formatTokens(d.contextUsage.totalTokens)} / {formatTokens(d.contextUsage.maxTokens)}
        </DetailRow>
      )}
      {categories.map((category) => (
        <DetailRow
          key={category.name}
          label={category.name}
          indent
          swatch={category.color}
          data-testid={`context-category-${category.name}`}
        >
          {formatTokens(category.tokens)}
        </DetailRow>
      ))}
      {d.cache === null ? (
        <DetailRow label="Cache">nothing cached yet</DetailRow>
      ) : (
        <>
          <DetailRow label="Cache hit">{`${cacheHitPercent(d.cache)}%`}</DetailRow>
          <DetailRow label="Cache read" indent>
            {formatTokens(d.cache.readTokens)}
          </DetailRow>
          <DetailRow label="Cache written" indent>
            {formatTokens(d.cache.creationTokens)}
          </DetailRow>
        </>
      )}
      {d.usage !== null && hasRenderableUsage(d.usage) ? (
        <div className="pt-1">
          <UsageDetail usage={d.usage} />
        </div>
      ) : (
        <DetailRow label="Usage & cost">no usage reported</DetailRow>
      )}
    </Group>
  );
}

/** Helper agents — what is running now, what just finished, and what could be called. */
function SubagentsGroup({ diagnostics: d }: { diagnostics: SessionDiagnostics }) {
  // The fold keeps one row per task for the whole turn, terminal rows included,
  // and the store keeps the turn's events after `turn_end` until the reconcile
  // reloads history. Rendering the list wholesale under "Running" therefore
  // asserted that three FINISHED subagents were still running, badged `complete`.
  const { running, finished } = partitionSubagents(d.activeSubagents);

  return (
    <Group label="Subagents">
      {/* Counted, not just listed, so the running rows are unambiguously labelled
          once "Finished this turn" sits below them — and so the server's own count
          has somewhere honest to contradict this one. */}
      <DetailRow label="Running">{runningLabel(running.length, d.runningSubagentCount)}</DetailRow>
      {running.map((subagent) => (
        <SubagentRow key={subagent.taskId} subagent={subagent} />
      ))}
      {finished.length > 0 && (
        <>
          <DetailRow label="Finished this turn">{String(finished.length)}</DetailRow>
          {finished.map((subagent) => (
            <SubagentRow key={subagent.taskId} subagent={subagent} />
          ))}
        </>
      )}
      <DetailRow label="Available">
        {d.subagents.length === 0 ? 'none' : d.subagents.map((a) => a.name).join(', ')}
      </DetailRow>
    </Group>
  );
}

/** One subagent: what it was asked to do, its status, and its tool tally. */
function SubagentRow({ subagent }: { subagent: ActiveSubagent }) {
  return (
    <div
      data-testid={`active-subagent-${subagent.taskId}`}
      data-status={subagent.status}
      className="space-y-0.5 py-1"
    >
      <div className="flex items-center gap-2">
        <Users className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{subagent.description ?? subagent.taskId}</span>
        <Badge size="xs" variant="secondary" className="shrink-0">
          {subagent.status}
        </Badge>
      </div>
      <p className="text-muted-foreground text-3xs pl-5 leading-tight">
        {subagent.toolUses ?? 0} tool{subagent.toolUses === 1 ? '' : 's'}
        {subagent.lastToolName ? ` · last ${subagent.lastToolName}` : ''}
      </p>
    </div>
  );
}

/** One titled section of the readout. */
function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="min-w-0">
      <h3 className="text-muted-foreground px-1 pb-1 text-xs font-medium tracking-wide uppercase">
        {label}
      </h3>
      {/* The padding and the type size belong to the group, not to each row —
          they used to be re-stated on every single one. */}
      <div className="space-y-1 px-1 text-xs">{children}</div>
    </section>
  );
}

/** Plain-language turn state — the coarse answer plus the honest sub-state. */
function turnLabel(d: SessionDiagnostics): string {
  if (d.triggerPending) return 'sending';
  if (d.streaming) return 'streaming';
  return d.lifecycle ?? 'not hydrated';
}

/**
 * How many subagents are running, and what the server says if it disagrees.
 *
 * The server projects `runningSubagentCount` from the same `subagent_update`
 * frames this client folds, so the two should never differ. When they do, one of
 * them is wrong — a dropped frame, or a fold that mis-read a terminal status — and
 * the surface built to diagnose a session has to say so rather than quietly pick a
 * side. Silent while they agree, which is always.
 *
 * @param folded - Running rows this client folded from the turn.
 * @param serverCount - The server's own count, or `null` before the stream hydrates.
 */
function runningLabel(folded: number, serverCount: number | null): string {
  const own = folded === 0 ? 'none' : String(folded);
  if (serverCount === null || serverCount === folded) return own;
  return `${own} · server says ${serverCount}`;
}

/**
 * Branch + cleanliness, the absence of a repository, or the honest silence of a
 * question not yet answered — three states, because `—` and `no repo` are
 * different claims and only one of them can be wrong about a real checkout.
 *
 * @param git - The snapshot's repository state.
 */
function gitLabel(git: GitDiagnostics): string {
  if (git.state === 'unknown') return '—';
  if (git.state === 'no-repo') return 'no repo';
  return git.dirty ? `${git.branch} · changed` : `${git.branch} · clean`;
}

/**
 * Milliseconds since `timestamp`, re-read once a second so the readout ages in
 * place.
 *
 * Gated on `live`, because being mounted is not the same as being visible: the
 * right panel keeps its active tab mounted and collapses to zero width, so an
 * ungated interval kept re-rendering this group every second behind a closed
 * panel — and since the active tab is persisted, closing the panel on the Session
 * tab was enough to reach that state. Re-reads the clock when it becomes visible
 * again so the first render after reopening is not up to a second stale.
 *
 * @param timestamp - `Date.now()` of the last event, or `null` before hydration.
 * @param live - Whether the readout is on screen.
 */
function useAgeSince(timestamp: number | null, live: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (timestamp === null || !live) return;
    const sample = () => setNow(Date.now());
    // Read once on becoming visible, so the first render after reopening is not
    // a whole tick stale.
    sample();
    const id = setInterval(sample, AGE_TICK_MS);
    return () => clearInterval(id);
  }, [timestamp, live]);
  if (timestamp === null) return null;
  return Math.max(0, now - timestamp);
}
