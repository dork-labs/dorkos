import type { Session } from '@dorkos/shared/types';
import { SessionRowFull } from './SessionRowFull';
import { SessionRowCompact } from './SessionRowCompact';

export interface SessionRowProps {
  /** Display variant. 'full' renders expand/rename/details; 'compact' is a minimal single-line row. */
  variant: 'full' | 'compact';
  /** Session to render. */
  session: Session;
  /** Whether this row represents the currently focused session. */
  isActive: boolean;
  /** Fired when the row is clicked or activated via Enter/Space. */
  onClick: () => void;
  /** Optional fork handler. When omitted, the Fork option is hidden. */
  onFork?: (sessionId: string) => void;
  /** Optional rename handler. When omitted, the rename affordance is hidden. */
  onRename?: (sessionId: string, title: string) => void;
  /** Set to true to play an entry animation (fade + slide). Only used by the 'full' variant. */
  isNew?: boolean;
}

/** Unified session row — delegates to full (border) or compact (dot) sub-variant. */
export function SessionRow({
  variant,
  session,
  isActive,
  onClick,
  onFork,
  onRename,
  isNew,
}: SessionRowProps) {
  if (variant === 'compact') {
    return (
      <SessionRowCompact
        session={session}
        isActive={isActive}
        onClick={onClick}
        onFork={onFork}
        onRename={onRename}
      />
    );
  }

  return (
    <SessionRowFull
      session={session}
      isActive={isActive}
      onClick={onClick}
      onFork={onFork}
      onRename={onRename}
      isNew={isNew}
    />
  );
}
