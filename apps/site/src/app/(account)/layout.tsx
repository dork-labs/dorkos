import Link from 'next/link';

/**
 * Layout for the DorkOS account pages (accounts-and-auth P2). A minimal,
 * distraction-free centered shell — no marketing navigation — so sign-in,
 * sign-up, verification, reset, and the profile all sit in the same calm frame.
 */
export default function AccountLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex items-center px-6 py-5">
        <Link href="/" className="font-mono text-sm font-semibold tracking-tight">
          DorkOS
        </Link>
      </header>
      <main className="flex flex-1 items-center justify-center px-6 pb-16">{children}</main>
    </div>
  );
}
