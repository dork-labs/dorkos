import { useId, useState, type FormEvent } from 'react';
import { Button, Input, Label } from '@/layers/shared/ui';

interface TypedPathMoveProps {
  /** Move the backup to this typed folder. */
  onSubmit: (path: string) => void;
  /** The server's sentence when it refused the last typed folder. */
  error: string | null;
  /** A move is running. */
  pending: boolean;
}

/**
 * Type a folder path for a Move, for a folder the browser above can't reach,
 * like an external drive under `/Volumes`. The server checks every path, so
 * this only collects one and shows its refusal (DOR-4253).
 */
export function TypedPathMove({ onSubmit, error, pending }: TypedPathMoveProps) {
  const id = useId();
  const [path, setPath] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();
    const trimmed = path.trim();
    if (trimmed) onSubmit(trimmed);
  }

  return (
    <form onSubmit={submit} className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        Or type a folder path
      </Label>
      <div className="flex gap-2">
        <Input
          id={id}
          value={path}
          onChange={(event) => setPath(event.target.value)}
          placeholder="/Volumes/…"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          className="font-mono text-xs"
        />
        <Button type="submit" size="sm" variant="outline" disabled={pending || !path.trim()}>
          Move here
        </Button>
      </div>
      {error && (
        <p id={`${id}-error`} role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </form>
  );
}
