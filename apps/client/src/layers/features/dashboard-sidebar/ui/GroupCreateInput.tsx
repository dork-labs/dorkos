import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { FolderPlus } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { SidebarMenuItem } from '@/layers/shared/ui';

/** Minimum group-name length (trimmed). */
const MIN_NAME = 1;
/** Maximum group-name length (matches `SidebarGroupSchema.name`). */
const MAX_NAME = 40;

interface GroupCreateInputProps {
  /** Commit a valid (1–40 char, trimmed) group name. */
  onCommit: (name: string) => void;
  /** Abandon the create flow (Esc or blur). */
  onCancel: () => void;
}

/**
 * Inline "new group" row: type a name, Enter commits, Esc (or blur) cancels.
 * Names are validated to 1–40 trimmed characters; invalid input never commits.
 */
export function GroupCreateInput({ onCommit, onCancel }: GroupCreateInputProps) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const commit = () => {
    const trimmed = value.trim();
    if (trimmed.length < MIN_NAME || trimmed.length > MAX_NAME) {
      onCancel();
      return;
    }
    committedRef.current = true;
    onCommit(trimmed);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      committedRef.current = true;
      onCancel();
    }
  };

  return (
    <SidebarMenuItem>
      <div className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5">
        <FolderPlus className="text-muted-foreground size-3.5 shrink-0" />
        <input
          ref={inputRef}
          value={value}
          maxLength={MAX_NAME}
          placeholder="Group name"
          aria-label="New group name"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            if (!committedRef.current) onCancel();
          }}
          className={cn(
            'bg-background text-foreground placeholder:text-muted-foreground/50',
            'focus-visible:ring-ring min-w-0 flex-1 rounded border px-1.5 py-0.5 text-xs outline-none focus-visible:ring-1'
          )}
        />
      </div>
    </SidebarMenuItem>
  );
}
