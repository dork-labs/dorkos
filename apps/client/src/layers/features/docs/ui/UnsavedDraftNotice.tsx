import { useEffect, useState } from 'react';
import type { DocRef } from '@dorkos/shared/doc-collab';
import { useTransport } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';

/** Props for {@link UnsavedDraftNotice}. */
export interface UnsavedDraftNoticeProps {
  /** The doc. */
  doc: DocRef;
  /** The doc's text as this editor last held it. */
  draft: string;
  /**
   * The file's hash the draft was written against (the last save the editor
   * heard of). Saving checks it, so a change somebody made since is never
   * replaced without asking. `null` when unknown: the file as it is now.
   */
  basedOn: string | null;
  /** Why the text is offered: live editing stopped, or the doc was reloaded under it. */
  reason: 'stopped' | 'replaced';
  /** The notice is done: `changed` when the file now holds the draft. */
  onDone: (changed: boolean) => void;
}

type State =
  | { kind: 'checking' }
  | { kind: 'differs'; hash: string }
  | { kind: 'conflict' }
  | { kind: 'saving' }
  /** `hash` is the file's, when it was read: a retry saves against it, or reads again. */
  | { kind: 'error'; hash?: string };

/**
 * Text that never reached the file (DOR-2984): the server stopped serving the
 * doc live (Docs turned off, the file too large) after this editor typed into
 * it, or reloaded the doc under it and could not keep the text as a version.
 * Offered back rather than dropped, through the same save the file editor
 * uses, checked against the file the text was based on, so a change somebody
 * made since is never replaced without asking. Says nothing when the file
 * already holds it.
 */
export function UnsavedDraftNotice({
  doc,
  draft,
  basedOn,
  reason,
  onDone,
}: UnsavedDraftNoticeProps) {
  const transport = useTransport();
  const [state, setState] = useState<State>({ kind: 'checking' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    transport.readFileContent(doc.cwd, doc.path).then(
      (file) => {
        if (cancelled) return;
        if (file.content === draft) onDone(false);
        else setState({ kind: 'differs', hash: basedOn ?? file.hash });
      },
      () => !cancelled && setState({ kind: 'error' })
    );
    return () => {
      cancelled = true;
    };
  }, [transport, doc.cwd, doc.path, draft, basedOn, onDone, attempt]);

  const save = async (expectedHash?: string) => {
    setState({ kind: 'saving' });
    try {
      const result = await transport.writeFile(
        doc.cwd,
        doc.path,
        draft,
        expectedHash ? { expectedHash } : undefined
      );
      if (result.ok) onDone(true);
      else setState({ kind: 'conflict' });
    } catch {
      setState({ kind: 'error', ...(expectedHash ? { hash: expectedHash } : {}) });
    }
  };

  const act = () => {
    if (state.kind === 'differs') return void save(state.hash);
    if (state.kind === 'conflict') return void save();
    if (state.kind === 'error' && state.hash) return void save(state.hash);
    // The file was never read: read it again before saving over anything.
    setState({ kind: 'checking' });
    setAttempt((n) => n + 1);
  };

  if (state.kind === 'checking') return null;
  const message =
    state.kind === 'conflict'
      ? 'The file changed since. Saving replaces those changes.'
      : state.kind === 'error'
        ? 'Couldn’t save your last edits. Try again.'
        : reason === 'replaced'
          ? 'This doc was reloaded. Your earlier edits weren’t merged into it.'
          : 'Live editing stopped before your last edits reached the file.';
  return (
    <div
      role="status"
      className="bg-muted mx-2 mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-3 py-2 text-sm"
    >
      <span className="flex-1">{message}</span>
      <Button
        type="button"
        size="sm"
        className="h-7"
        disabled={state.kind === 'saving'}
        onClick={act}
      >
        {state.kind === 'conflict' ? 'Save anyway' : 'Save them'}
      </Button>
      <Button type="button" variant="ghost" size="sm" className="h-7" onClick={() => onDone(false)}>
        Discard
      </Button>
    </div>
  );
}
