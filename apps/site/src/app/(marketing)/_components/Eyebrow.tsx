import type { ReactNode } from 'react';

/** Tiny mono kicker above a headline — the page's instrument label. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="text-2xs text-brand-orange font-mono tracking-[0.2em] uppercase">{children}</p>
  );
}
