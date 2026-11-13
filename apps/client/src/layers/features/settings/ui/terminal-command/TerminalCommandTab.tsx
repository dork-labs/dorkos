import { useCallback, useEffect, useState } from 'react';
import {
  getTerminalCommandBridge,
  type TerminalCommandBridge,
  type TerminalCommandStatus,
} from '@/layers/shared/lib';
import { useCopyFeedback } from '@/layers/shared/lib/use-copy-feedback';
import { Button, FieldCard, FieldCardContent, SettingRow } from '@/layers/shared/ui';

/** What the row shows: the state, or a failed Install or Remove with its plain reason. */
type View =
  | { kind: 'checking' }
  | { kind: 'status'; status: TerminalCommandStatus }
  | { kind: 'failed'; action: 'install' | 'remove'; reason: string; status: TerminalCommandStatus };

/** A path or command in the row's text, in mono. */
function Mono({ children, path = false }: { children: string; path?: boolean }) {
  // A path can be one long word, so it may break anywhere rather than run out of the
  // card at 390. A word in a sentence, like `dorkos`, never splits.
  return (
    <code className={path ? 'font-mono text-xs break-all' : 'font-mono text-xs whitespace-nowrap'}>
      {children}
    </code>
  );
}

/** The line to add, with Copy that reads "Copied" for a moment. */
function CopyLine({ line }: { line: string }) {
  const { copied, copy } = useCopyFeedback({ timeoutMs: 1500 });
  return (
    <div className="bg-muted flex items-center justify-between gap-2 rounded-lg px-3 py-2">
      <code className="min-w-0 font-mono text-xs break-words">{line}</code>
      <Button variant="secondary" size="sm" className="shrink-0" onClick={() => void copy(line)}>
        {copied ? 'Copied' : 'Copy'}
      </Button>
    </div>
  );
}

/** The row's words for a state. */
function Description({ view }: { view: Exclude<View, { kind: 'checking' }> }) {
  if (view.kind === 'failed')
    return (
      <>
        Couldn’t {view.action}: {view.reason}
      </>
    );
  const { status } = view;
  switch (status.state) {
    case 'unavailable':
      return <>The Terminal command comes with the Mac app.</>;
    case 'not-installed':
      return (
        <>
          Use <Mono>dorkos</Mono> from Terminal. No admin password needed.
        </>
      );
    case 'installed':
      return (
        <>
          Installed at <Mono path>{status.path}</Mono>.
        </>
      );
    case 'not-found':
      return (
        <>
          <span className="block">Installed, but Terminal can’t find it yet.</span>
          <span className="block">
            Add this line to <Mono path>{status.shellFile}</Mono>, then open a new Terminal window.
          </span>
        </>
      );
    case 'shadowed':
      return (
        <>
          Terminal finds another <Mono>dorkos</Mono> first, at <Mono path>{status.otherPath}</Mono>
          {status.otherVersion ? ` (${status.otherVersion})` : ''}.
        </>
      );
  }
}

/** Install, Remove or Try again, whichever this state offers. */
function Action({
  view,
  busy,
  onInstall,
  onRemove,
}: {
  view: View;
  busy: boolean;
  onInstall: () => void;
  onRemove: () => void;
}) {
  if (view.kind === 'checking') return null;
  if (view.kind === 'failed')
    return (
      <Button
        variant="secondary"
        size="sm"
        loading={busy}
        loadingLabel={view.action === 'install' ? 'Installing…' : 'Removing…'}
        onClick={view.action === 'install' ? onInstall : onRemove}
      >
        Try again
      </Button>
    );
  if (view.status.state === 'unavailable') return null;
  if (view.status.state === 'not-installed')
    return (
      <Button
        variant="secondary"
        size="sm"
        loading={busy}
        loadingLabel="Installing…"
        onClick={onInstall}
      >
        Install
      </Button>
    );
  return (
    <Button
      variant="secondary"
      size="sm"
      loading={busy}
      loadingLabel="Removing…"
      onClick={onRemove}
    >
      Remove
    </Button>
  );
}

/**
 * Settings → This computer → Terminal command (DOR-3105): an opt-in `dorkos` for
 * the person's own Terminal, installed by the Mac app to `~/.local/bin`. The state
 * is read fresh each time this tab opens. The words are the designer's five
 * states; Install never replaces a file the person put there, and agents can't
 * write the script.
 */
export function TerminalCommandTab({
  bridge = getTerminalCommandBridge(),
}: {
  /** The desktop bridge; tests pass a fake. */
  bridge?: TerminalCommandBridge | null;
}) {
  const [view, setView] = useState<View>(() =>
    bridge ? { kind: 'checking' } : { kind: 'status', status: { state: 'unavailable' } }
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    if (!bridge) return;
    bridge
      .status()
      .then((status) => live && setView({ kind: 'status', status }))
      .catch(() => live && setView({ kind: 'status', status: { state: 'unavailable' } }));
    return () => {
      live = false;
    };
  }, [bridge]);

  const run = useCallback(
    async (action: 'install' | 'remove') => {
      if (!bridge || view.kind === 'checking') return;
      const before = view.status;
      setBusy(true);
      try {
        setView({ kind: 'status', status: await bridge[action]() });
      } catch (err) {
        setView({ kind: 'failed', action, reason: (err as Error).message, status: before });
      } finally {
        setBusy(false);
      }
    },
    [bridge, view]
  );

  const status = view.kind === 'checking' ? null : view.status;
  const line =
    status && (status.state === 'not-found' || status.state === 'shadowed') ? status.line : null;

  return (
    <div className="space-y-4">
      <FieldCard>
        <FieldCardContent>
          <SettingRow
            label="Terminal command"
            // Below 480px the action sits under the words, left-aligned, so the
            // words keep the card's full width.
            className="max-[480px]:flex-col max-[480px]:items-start max-[480px]:gap-3"
            description={view.kind === 'checking' ? 'Checking…' : <Description view={view} />}
          >
            <Action
              view={view}
              busy={busy}
              onInstall={() => void run('install')}
              onRemove={() => void run('remove')}
            />
          </SettingRow>
          {line && view.kind === 'status' && <CopyLine line={line} />}
        </FieldCardContent>
      </FieldCard>
    </div>
  );
}
