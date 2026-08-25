import type { ReactNode } from 'react';

/** Tiny mono kicker above a headline — the page's instrument label. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return <p className="text-2xs font-mono tracking-[0.2em] text-(--ember) uppercase">{children}</p>;
}
