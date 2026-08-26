import type { Metadata } from 'next';
import { Suspense } from 'react';
import { siteConfig } from '@/config/site';
import { rssFeedAlternateTypes, twitterFromOpenGraph } from '@/lib/metadata';
import {
  PresentationShell,
  StoryHero,
  FounderSection,
  MondayMorningSection,
  HowItBuiltSection,
  JustPromptsSection,
  DemoSection,
  CloseSection,
  FutureVisionSection,
  MarketingHeader,
  MarketingFooter,
  FOOTER_SOCIAL_LINKS,
} from '@/layers/features/marketing';

const storyTitle = 'The Story — DorkOS';
const storyDescription =
  'How DorkOS started: one founder, a fleet of coding agents, and the bet that coordination scales further than raw intelligence.';

export const metadata: Metadata = {
  title: 'The Story',
  description: storyDescription,
  alternates: { canonical: '/story', types: rssFeedAlternateTypes },
  openGraph: {
    title: storyTitle,
    description: storyDescription,
    url: '/story',
    type: 'article',
    siteName: siteConfig.name,
  },
  twitter: twitterFromOpenGraph({ title: storyTitle, description: storyDescription }),
};

// Reuse the same social links defined on the homepage

/**
 * The DorkOS origin story -- Dorian's personal arc from LifeOS to multi-agent coordination.
 *
 * Add ?present=true for presentation mode: full-screen snap sections + keyboard navigation.
 */
export default function StoryPage() {
  return (
    // Suspense required: PresentationShell uses useSearchParams internally
    <Suspense fallback={null}>
      <PresentationShell>
        <div data-marketing-header>
          <MarketingHeader />
        </div>

        <StoryHero />
        <FounderSection />
        <MondayMorningSection />
        <HowItBuiltSection />
        <JustPromptsSection />
        <DemoSection />
        <CloseSection />
        <FutureVisionSection />

        <div data-marketing-footer>
          <MarketingFooter email={siteConfig.contactEmail} socialLinks={FOOTER_SOCIAL_LINKS} />
        </div>
      </PresentationShell>
    </Suspense>
  );
}
