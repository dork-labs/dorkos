import { useEffect, useId, useRef, useState } from 'react';
import { Button, Input } from '@/layers/shared/ui';
/** Write-only local editor. No value prop, query cache, snapshot echo or debug receipt. */
export function ManagedBrowserSecretEditor({
  targetLabel,
  disabled,
  onWrite,
}: {
  targetLabel: string;
  disabled: boolean;
  onWrite: (text: string) => Promise<void>;
}) {
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [confirmed, setConfirmed] = useState(false),
    [visible, setVisible] = useState(false),
    [failed, setFailed] = useState(false);
  const sending = useRef(false);
  const composing = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    const original = input.current;
    return () => {
      live.current = false;
      composing.current = false;
      if (original) original.value = '';
    };
  }, []);
  const submit = () => {
    const original = input.current;
    if (
      !original ||
      disabled ||
      !confirmed ||
      composing.current ||
      sending.current ||
      !original.value
    )
      return;
    sending.current = true;
    const text = original.value;
    original.value = '';
    setConfirmed(false);
    setVisible(false);
    setFailed(false);
    void Promise.resolve()
      .then(() => onWrite(text))
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
    <form
      aria-label="Write secret to selected field"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
      className="space-y-3"
    >
      <p className="text-muted-foreground text-xs">
        Write to {targetLabel}. The existing value stays hidden.
      </p>
      <label htmlFor={inputId} className="block text-sm">
        New secret
        <Input
          id={inputId}
          ref={input}
          type={visible ? 'text' : 'password'}
          autoComplete="new-password"
          maxLength={2048}
          disabled={disabled}
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
            ) {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) event.preventDefault();
              return;
            }
            if (event.key === 'Escape') {
              event.preventDefault();
              event.currentTarget.value = '';
              setConfirmed(false);
              setVisible(false);
            }
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submit();
            }
          }}
        />
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={visible}
          disabled={disabled}
          onChange={(event) => setVisible(event.target.checked)}
        />
        Show local text
      </label>
      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={disabled}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        I confirm this is the field I want to write to.
      </label>
      <Button size="sm" type="submit" disabled={disabled || !confirmed}>
        Write secret
      </Button>
      {failed && (
        <p role="alert" className="text-destructive text-xs">
          The write could not be confirmed. Read the page again before another write.
        </p>
      )}
    </form>
  );
}
