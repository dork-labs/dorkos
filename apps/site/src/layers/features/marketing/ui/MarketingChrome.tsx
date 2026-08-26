import { siteConfig } from '@/config/site';
import { MarketingHeader } from './MarketingHeader';
import { MarketingFooter } from './MarketingFooter';
import { MarketingNav } from './MarketingNav';
import { NAV_LINKS } from '../lib/nav-links';
import { FOOTER_SOCIAL_LINKS } from '../lib/footer-social-links';

/**
 * Standard marketing chrome — fixed header, footer, and bottom pill nav — so
 * secondary pages (features, catalog detail) share the homepage frame and never
 * dead-end without a way back.
 *
 * @param children - Page content, rendered between the header and footer.
 */
export function MarketingChrome({ children }: { children: React.ReactNode }) {
  return (
    <>
      <MarketingHeader />
      {children}
      <MarketingFooter email={siteConfig.contactEmail} socialLinks={FOOTER_SOCIAL_LINKS} />
      <MarketingNav links={NAV_LINKS} />
    </>
  );
}
