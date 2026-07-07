import type { Metadata } from 'next';
import Link from 'next/link';

import { ImpersonationBanner } from '@/layers/features/admin';

/**
 * Admin console layout: a plain control-panel shell (no marketing chrome), the
 * app-wide impersonation banner, and `noindex` so the surface never lands in
 * search results. The real access control is the server-side `requireAdminSession`
 * guard on the page; this layout only frames it.
 */
export const metadata: Metadata = {
  title: 'Admin · DorkOS',
  robots: { index: false, follow: false },
};

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <ImpersonationBanner />
      <header className="flex items-center justify-between border-b px-6 py-4">
        <div className="flex items-center gap-3">
          <Link href="/" className="font-mono text-sm font-semibold tracking-tight">
            DorkOS
          </Link>
          <span className="text-muted-foreground text-sm">Admin</span>
        </div>
        <Link href="/account" className="text-muted-foreground hover:text-foreground text-sm">
          Account
        </Link>
      </header>
      <main className="flex-1 px-6 py-8">
        <div className="mx-auto w-full max-w-4xl">{children}</div>
      </main>
    </div>
  );
}
