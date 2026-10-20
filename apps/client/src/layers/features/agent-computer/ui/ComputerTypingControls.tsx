import { useEffect, useRef, useState } from 'react';
import { Button, Input } from '@/layers/shared/ui';
import type { ComputerInput } from '@dorkos/shared/computer-schemas';

type InputEvent = ComputerInput extends infer I
  ? I extends ComputerInput
    ? Omit<I, 'leaseId' | 'generation'>
    : never
  : never;

/** Lease-local draft: losing control discards private text before another takeover. */
export function ComputerTypingControls({
  send,
}: {
  send: (event: InputEvent) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState('');
  const [typing, setTyping] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <form
      className="flex flex-wrap gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!draft || typing) return;
        const text = draft;
        setTyping(true);
        void send({ kind: 'text', text })
          .then((sent) => {
            if (mounted.current && sent) setDraft((current) => (current === text ? '' : current));
          })
          .finally(() => {
            if (mounted.current) setTyping(false);
          });
      }}
    >
      <Input
        aria-label="Type on computer"
        placeholder="Type on computer"
        value={draft}
        maxLength={4096}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        className="min-w-0 flex-1"
        onChange={(event) => setDraft(event.target.value)}
      />
      <Button type="submit" aria-disabled={typing || !draft} aria-busy={typing}>
        Type
      </Button>
      <Button
        type="button"
        variant="outline"
        onClick={() => {
          void send({ kind: 'key', key: 'Enter', action: 'down' });
          void send({ kind: 'key', key: 'Enter', action: 'up' });
        }}
      >
        Enter
      </Button>
    </form>
  );
}
