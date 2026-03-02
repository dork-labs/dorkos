import Image from 'next/image'

/** Branded logo + wordmark for the docs navigation bar. */
export function DocsNavTitle() {
  return (
    <span className="inline-flex items-center gap-2">
      <Image
        src="/images/dork-logo.svg"
        alt="DorkOS"
        width={40}
        height={40}
        className="block dark:hidden"
      />
      <Image
        src="/images/dork-logo-white.svg"
        alt="DorkOS"
        width={40}
        height={40}
        className="hidden dark:block"
      />
      <span className="font-mono text-xs tracking-[0.15em] uppercase font-medium">
        DorkOS
      </span>
    </span>
  )
}
