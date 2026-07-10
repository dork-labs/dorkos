import type { ReactNode } from 'react';
import { MarketingChrome } from '@/layers/features/marketing';

/**
 * Layout for marketplace pages within the marketing route group.
 *
 * Wraps the browse page, package detail pages, and the telemetry privacy page
 * in the shared marketing chrome (header, footer, bottom pill nav) so every
 * marketplace route shares the homepage frame instead of rendering chrome-less.
 */
export default function MarketplaceLayout({ children }: { children: ReactNode }) {
  return <MarketingChrome>{children}</MarketingChrome>;
}
