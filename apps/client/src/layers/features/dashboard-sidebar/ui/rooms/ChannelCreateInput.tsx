import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { Hash } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { SidebarMenuItem } from '@/layers/shared/ui';

/** Minimum channel-name length (trimmed). */
const MIN_NAME = 1;
/** Maximum channel-name length (matches `CreateRoomRequestSchema.title`). */
const MAX_NAME = 200;

interface ChannelCreateInputProps {
  /** Commit a valid (1–200 char, trimmed) channel name. */
  onCommit: (name: string) => void;
  /** Abandon the create flow (Esc or blur). */
  onCancel: () => void;
}

/**
 * Inline "new channel" row: type a name, Enter creates it, Esc (or blur)
 * cancels. Mirrors `GroupCreateInput` — the same gesture the sidebar already
 * uses for creating something in place.
 *
 * The server derives the `#slug` from the name, so this asks for a name a
 * person would say out loud rather than making them type punctuation.
 */
export function ChannelCreateInput({ onCommit, onCancel }: ChannelCreateInputProps) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const commit = () => {
    // First Enter/Escape decides; everything after is a no-op — guards
    // double-Enter and the blur that follows a commit.
    if (committedRef.current) return;
    committedRef.current = true;
    const trimmed = value.trim();
    if (trimmed.length < MIN_NAME || trimmed.length > MAX_NAME) {
      onCancel();
      return;
    }
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
      {/* 44px of row on a phone, the same as every other thing you tap in this
          sidebar, and the same as the agent rows in the direct-message picker
          next door. Above the breakpoint it collapses back to the dense row
          the rest of the sidebar uses. */}
      <div className="flex min-h-11 w-full items-center gap-2 rounded-md px-2.5 py-1.5 md:min-h-0">
        <Hash className="text-muted-foreground size-3.5 shrink-0" />
        <input
          ref={inputRef}
          value={value}
          maxLength={MAX_NAME}
          placeholder="Channel name"
          aria-label="New channel name"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            if (!committedRef.current) onCancel();
          }}
          className={cn(
            'bg-background text-foreground placeholder:text-muted-foreground/50',
            'focus-visible:ring-ring min-w-0 flex-1 rounded border px-1.5 py-2 text-sm outline-none focus-visible:ring-1',
            'md:py-0.5 md:text-xs'
          )}
        />
      </div>
    </SidebarMenuItem>
  );
}
