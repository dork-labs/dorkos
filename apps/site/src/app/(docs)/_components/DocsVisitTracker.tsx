'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { trackDocsVisit } from '@/lib/analytics';

/**
 * Fires the `docs_visit` funnel event once per distinct `/docs` path.
 *
 * The `(docs)` layout is a server component and stays mounted across
 * client-side navigation between doc pages, so this tiny client component is
 * the mount point: it watches the pathname and reports each new one,
 * including the first (whether the visitor lands directly on a sub-page or
 * navigates in from elsewhere on the site). Renders nothing.
 */
export function DocsVisitTracker() {
  const pathname = usePathname();
  const lastPathRef = useRef<string | null>(null);

  useEffect(() => {
    if (lastPathRef.current === pathname) return;
    lastPathRef.current = pathname;
    trackDocsVisit(pathname);
  }, [pathname]);

  return null;
}
