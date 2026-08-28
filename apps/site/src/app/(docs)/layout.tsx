import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';
import { source } from '@/lib/source';
import { siteConfig } from '@/config/site';
import { FOOTER_SOCIAL_LINKS, MarketingFooter } from '@/layers/features/marketing';
import { DocsNavTitle } from './_components/DocsNavTitle';
import { DocsVisitTracker } from './_components/DocsVisitTracker';
import 'fumadocs-ui/style.css';

/**
 * Layout for the /docs route group.
 *
 * Wraps all documentation pages with the Fumadocs sidebar navigation
 * and root provider for search, theme, and framework integration.
 */
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <RootProvider>
      <DocsVisitTracker />
      <div className="flex min-h-screen flex-col">
        <DocsLayout
          containerProps={{ className: 'flex-1' }}
          tree={source.pageTree}
          nav={{ title: <DocsNavTitle />, url: '/' }}
        >
          {children}
        </DocsLayout>
        <MarketingFooter email={siteConfig.contactEmail} socialLinks={FOOTER_SOCIAL_LINKS} />
      </div>
    </RootProvider>
  );
}
