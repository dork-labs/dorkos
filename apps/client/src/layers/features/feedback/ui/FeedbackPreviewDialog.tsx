import { Lock } from 'lucide-react';
import type { FeedbackDiagnostics, FeedbackSubmissionKind } from '@dorkos/shared/telemetry-events';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  ResponsiveDialogDescription,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  ScrollArea,
  Skeleton,
} from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { useIsMobile } from '@/layers/shared/model';
import { useTranscriptPreview } from '../model/use-transcript-preview';

/** Which preview tab is showing. */
export type FeedbackPreviewTab = 'diagnostics' | 'conversation' | 'screenshot';

interface FeedbackPreviewDialogProps {
  /** Whether the preview is open. */
  open: boolean;
  /** Open/close the preview. */
  onOpenChange: (open: boolean) => void;
  /** Which tab to show first. */
  initialTab: FeedbackPreviewTab;
  /** The diagnostics bundle that would be sent, or `undefined` while config loads. */
  diagnostics: FeedbackDiagnostics | undefined;
  /** The submission kind — a server log excerpt is added for `bug` only. */
  kind: FeedbackSubmissionKind;
  /** Whether the Conversation tab is available (a session is resolvable). */
  showConversation: boolean;
  /** The session the transcript preview reads from. */
  sessionId: string | undefined;
  /**
   * The compressed screenshot that will be sent, or `undefined` when none is
   * attached — in which case the Screenshot tab does not exist at all.
   */
  screenshotDataUrl?: string;
}

/** The privacy scope line, repeated at the foot of the preview (design §5). */
function PrivacyNote() {
  return (
    <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
      <Lock className="size-3 shrink-0" aria-hidden />
      Private. Only the DorkOS core team sees these. Never public.
    </p>
  );
}

/** One label/value row in the diagnostics list. */
function DiagRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1">
      <span className="text-muted-foreground shrink-0 text-xs">{label}</span>
      <span className="text-foreground text-right font-mono text-xs break-all">{value}</span>
    </div>
  );
}

/** The diagnostics preview: the exact clientReport + breadcrumbs that will be sent. */
function DiagnosticsPreview({
  diagnostics,
  kind,
}: {
  diagnostics: FeedbackDiagnostics | undefined;
  kind: FeedbackSubmissionKind;
}) {
  if (!diagnostics) {
    return <p className="text-muted-foreground text-xs">Gathering diagnostics…</p>;
  }
  const { clientReport, breadcrumbs } = diagnostics;
  const { viewport, browser, shell, theme, locale, timezone } = clientReport;
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border p-3">
        <DiagRow label="Version" value={clientReport.version} />
        <DiagRow label="Platform" value={clientReport.platform} />
        <DiagRow
          label="Runtimes"
          value={clientReport.runtimes.length ? clientReport.runtimes.join(', ') : 'none'}
        />
        {/* The environment rows (DOR-1960). Each is rendered only when the
            capture actually answered it, so this list is the payload and not a
            menu of fields that might be filled in — the preview's whole job is
            that what is shown is what goes. */}
        {viewport && (
          <DiagRow
            label="Window"
            value={`${viewport.width}×${viewport.height}${
              viewport.devicePixelRatio !== 1 ? ` @${viewport.devicePixelRatio}x` : ''
            }`}
          />
        )}
        {shell && <DiagRow label="Shell" value={shell} />}
        {theme && <DiagRow label="Theme" value={theme} />}
        {locale && <DiagRow label="Locale" value={locale} />}
        {timezone && <DiagRow label="Timezone" value={timezone} />}
        {browser && <DiagRow label="Browser" value={browser} />}
        {Object.entries(clientReport.flags).map(([key, value]) => (
          <DiagRow key={key} label={key} value={String(value)} />
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-xs font-medium">
          Recent events ({breadcrumbs?.length ?? 0})
        </span>
        {breadcrumbs && breadcrumbs.length > 0 ? (
          <ul className="flex flex-col gap-1">
            {breadcrumbs.map((crumb, i) => (
              <li key={i} className="text-foreground font-mono text-xs break-all">
                <span className="text-muted-foreground">{crumb.kind}</span> {crumb.message}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground text-xs">No recent errors or warnings.</p>
        )}
      </div>

      {kind === 'bug' && (
        <p className="text-muted-foreground text-xs">
          A scrubbed excerpt of recent server logs is added when you send. Home paths shown as ~,
          tokens removed.
        </p>
      )}
    </div>
  );
}

/** The conversation preview: a faithful, scrubbed approximation of the transcript excerpt. */
function ConversationPreview({
  sessionId,
  active,
}: {
  sessionId: string | undefined;
  active: boolean;
}) {
  const { text, isLoading, isError } = useTranscriptPreview(sessionId, active);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  if (isError) {
    return <p className="text-muted-foreground text-xs">Couldn’t load the conversation preview.</p>;
  }
  if (!text) {
    return <p className="text-muted-foreground text-xs">No recent conversation to attach.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">
        The last ~10 turns of this conversation, gathered and scrubbed when you send. Home paths
        shown as ~, tokens removed, long tool output trimmed.
      </p>
      <pre className="text-foreground bg-muted/40 rounded-md p-3 font-mono text-xs break-words whitespace-pre-wrap">
        {text}
      </pre>
    </div>
  );
}

/** The screenshot preview: the exact bytes that will be sent, at full width. */
function ScreenshotPreview({ dataUrl }: { dataUrl: string }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">
        This is the picture that goes with your report, exactly as we will send it. It is shrunk to
        keep the message small.
      </p>
      <img
        src={dataUrl}
        alt="The screenshot you attached"
        className="bg-muted/30 w-full rounded-md border object-contain"
      />
    </div>
  );
}

/**
 * The full preview of what a feedback submission will send: a tabbed, scrollable
 * surface showing the exact diagnostics bundle and a faithful, scrubbed preview
 * of the conversation excerpt (design-decisions §5). This is the mechanism that
 * keeps "pressing Send is the consent" honest — the user sees the full payload,
 * not just a checkbox.
 */
export function FeedbackPreviewDialog({
  open,
  onOpenChange,
  initialTab,
  diagnostics,
  kind,
  showConversation,
  sessionId,
  screenshotDataUrl,
}: FeedbackPreviewDialogProps) {
  const isDesktop = !useIsMobile();
  // A closed preview must not fetch; the Conversation tab only reads when the
  // preview is open on that tab. A tab whose content is not there cannot be the
  // landing tab either — fall back to the one tab that always exists.
  const available: FeedbackPreviewTab[] = [
    'diagnostics',
    ...(showConversation ? (['conversation'] as const) : []),
    ...(screenshotDataUrl ? (['screenshot'] as const) : []),
  ];
  const tab = available.includes(initialTab) ? initialTab : 'diagnostics';

  return (
    <ResponsiveDialog open={open} onOpenChange={onOpenChange}>
      <ResponsiveDialogContent className={cn('max-h-[85vh]', isDesktop && 'max-w-lg')}>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle className="text-sm font-medium">
            What will be sent
          </ResponsiveDialogTitle>
          <ResponsiveDialogDescription className="text-muted-foreground text-xs">
            Everything below rides along only if the matching toggle is on.
          </ResponsiveDialogDescription>
        </ResponsiveDialogHeader>

        {/* Keyed on the requested tab so reopening the preview on a different
            toggle always lands on that tab, even if the surface stayed mounted. */}
        <Tabs
          key={tab}
          defaultValue={tab}
          className="flex min-h-0 flex-col gap-3 px-4 pb-4 sm:px-0"
        >
          <TabsList
            className={cn(
              'grid',
              available.length === 3 && 'grid-cols-3',
              available.length === 2 && 'grid-cols-2',
              available.length === 1 && 'grid-cols-1'
            )}
          >
            <TabsTrigger value="diagnostics">Diagnostics</TabsTrigger>
            {showConversation && <TabsTrigger value="conversation">Conversation</TabsTrigger>}
            {screenshotDataUrl && <TabsTrigger value="screenshot">Screenshot</TabsTrigger>}
          </TabsList>

          <TabsContent value="diagnostics" className="min-h-0">
            <ScrollArea className="max-h-[45vh]">
              <DiagnosticsPreview diagnostics={diagnostics} kind={kind} />
            </ScrollArea>
          </TabsContent>

          {showConversation && (
            <TabsContent value="conversation" className="min-h-0">
              <ScrollArea className="max-h-[45vh]">
                <ConversationPreview sessionId={sessionId} active={open} />
              </ScrollArea>
            </TabsContent>
          )}

          {screenshotDataUrl && (
            <TabsContent value="screenshot" className="min-h-0">
              <ScrollArea className="max-h-[45vh]">
                <ScreenshotPreview dataUrl={screenshotDataUrl} />
              </ScrollArea>
            </TabsContent>
          )}

          <PrivacyNote />
        </Tabs>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}
