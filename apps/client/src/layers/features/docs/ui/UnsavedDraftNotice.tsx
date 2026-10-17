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
 * Text that never reached the file when live editing stopped (DOR-2984): the
 * server stopped serving the doc live (Docs turned off, the file too large)
 * after this editor typed into it. Offered back rather than dropped, through
 * the same save the file editor uses, conflict check included. Says nothing
 * when the file already holds it.
 */
export function UnsavedDraftNotice({ doc, draft, onDone }: UnsavedDraftNoticeProps) {
  const transport = useTransport();
  const [state, setState] = useState<State>({ kind: 'checking' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    transport.readFileContent(doc.cwd, doc.path).then(
      (file) => {
        if (cancelled) return;
        if (file.content === draft) onDone(false);
        else setState({ kind: 'differs', hash: file.hash });
      },
      () => !cancelled && setState({ kind: 'error' })
    );
    return () => {
      cancelled = true;
    };
  }, [transport, doc.cwd, doc.path, draft, onDone, attempt]);

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
