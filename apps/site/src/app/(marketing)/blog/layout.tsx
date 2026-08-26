import { RootProvider } from 'fumadocs-ui/provider/next';
import type { ReactNode } from 'react';
import { siteConfig } from '@/config/site';
import { FOOTER_SOCIAL_LINKS, MarketingFooter, MarketingHeader } from '@/layers/features/marketing';
import 'fumadocs-ui/style.css';

/**
 * Layout for blog pages within the marketing route group.
 *
 * Imports fumadocs-ui styles for DocsPage TOC and MDX component rendering.
 * Forces light theme since the marketing site uses a cream background.
 * Overrides fumadocs CSS custom properties to match the marketing palette.
 */
export default function BlogLayout({ children }: { children: ReactNode }) {
  return (
    <RootProvider theme={{ forcedTheme: 'light' }}>
      <MarketingHeader />
      <div
        style={
          {
            // Override fumadocs CSS variables to match marketing palette
            '--color-fd-foreground': 'var(--charcoal)',
            '--color-fd-muted-foreground': 'var(--warm-gray)',
            '--color-fd-muted': 'var(--cream-secondary)',
            '--color-fd-primary': 'var(--charcoal)',
            '--color-fd-background': 'var(--cream-primary)',
            '--color-fd-card': 'var(--cream-primary)',
            '--color-fd-border': 'var(--warm-gray-light)',
          } as React.CSSProperties
        }
      >
        {children}
        <MarketingFooter email={siteConfig.contactEmail} socialLinks={FOOTER_SOCIAL_LINKS} />
      </div>
    </RootProvider>
  );
}
