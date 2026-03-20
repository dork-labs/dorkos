import { DorkLogo } from '@dorkos/icons/logos';

/** Branded logo + wordmark for the docs navigation bar. */
export function DocsNavTitle() {
  return (
    <span className="inline-flex items-center gap-2">
      <DorkLogo size={40} className="block dark:hidden" />
      <DorkLogo variant="white" size={40} className="hidden dark:block" />
      <span className="font-mono text-xs font-medium tracking-[0.15em] uppercase">DorkOS</span>
    </span>
  );
}
