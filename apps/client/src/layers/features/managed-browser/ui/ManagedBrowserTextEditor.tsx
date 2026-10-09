import { useEffect, useId, useRef, useState } from 'react';
import {
  SemanticKeyV1Schema,
  type SemanticActionV1,
  type SemanticKeyV1,
} from '@dorkos/shared/browser-semantic-schemas';
import { Button, Input } from '@/layers/shared/ui';
/** Local draft, explicitly committed to an already focused canonical field. */
export function ManagedBrowserTextEditor({
  targetLabel,
  pending,
  onCommit,
}: {
  targetLabel: string;
  pending: boolean;
  onCommit: (action: SemanticActionV1['action']) => Promise<void>;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const sending = useRef(false),
    composing = useRef(false),
    live = useRef(true);
  const [failed, setFailed] = useState(false);
  const [key, setKey] = useState<SemanticKeyV1>('Enter');
  useEffect(() => {
    live.current = true;
    const original = input.current;
    return () => {
      live.current = false;
      if (original) original.value = '';
    };
  }, []);
  const commit = (kind: 'insertText' | 'replaceText' | 'key') => {
    if (!input.current || pending || sending.current || composing.current) return;
    const text = input.current.value;
    if (kind === 'insertText' && !text) return;
    input.current.value = '';
    sending.current = true;
    setFailed(false);
    void Promise.resolve()
      .then(() => onCommit(kind === 'key' ? { kind, key } : { kind, text }))
      .then(
        () => {
          sending.current = false;
        },
        () => {
          sending.current = false;
          if (live.current) setFailed(true);
        }
      );
  };
  return (
    <section aria-label="Edit selected text field" className="space-y-2">
      <p className="text-muted-foreground text-xs">Write to {targetLabel}.</p>
      <label htmlFor={id} className="block text-sm">
        New text
        <Input
          id={id}
          ref={input}
          autoComplete="off"
          maxLength={2048}
          readOnly={pending}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (
              composing.current ||
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            )
              return;
            if (event.key === 'Escape') {
              event.currentTarget.value = '';
            }
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              commit('insertText');
            }
          }}
        />
      </label>
      <div className="flex gap-2">
        <Button size="sm" disabled={pending} onClick={() => commit('insertText')}>
          Insert text
        </Button>
        <Button size="sm" disabled={pending} onClick={() => commit('replaceText')}>
          Replace text
        </Button>
      </div>
      <label className="block text-sm">
        Page key
        <select
          aria-label="Page key"
          value={key}
          disabled={pending}
          onChange={(event) => setKey(SemanticKeyV1Schema.parse(event.target.value))}
        >
          {SemanticKeyV1Schema.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
      <Button size="sm" disabled={pending} onClick={() => commit('key')}>
        Send key
      </Button>
      <p role="status" aria-live="polite" className="text-muted-foreground text-xs">
        {pending ? 'Checking this edit…' : 'Choose Insert text, Replace text, or Send key.'}
      </p>
      {failed && <p role="alert">The edit could not be confirmed. Read the page again.</p>}
    </section>
  );
}
