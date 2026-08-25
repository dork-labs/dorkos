import Link from 'next/link';
import { DorkLogo } from '@dorkos/icons/logos';

/** Minimal top bar: the mark home, and the one link that matters. */
export function PageNav() {
  return (
    <nav className="absolute inset-x-0 top-0 z-10 flex items-center justify-between px-6 py-5">
      <Link href="/" className="flex items-center gap-2.5" aria-label="DorkOS home">
        <DorkLogo variant="white" size={22} />
        <span className="font-mono text-sm tracking-[0.08em] text-(--cream)">DorkOS</span>
      </Link>
      <Link
        href="/install"
        className="text-2xs font-mono tracking-[0.15em] text-(--cream-dim) uppercase hover:text-(--cream)"
      >
        install
      </Link>
    </nav>
  );
}
