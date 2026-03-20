import type { Metadata } from 'next';
import { siteConfig } from '@/config/site';

export const metadata: Metadata = {
  title: `The Story | ${siteConfig.name}`,
  description:
    'How one person built an AI operating system for their whole life -- in two months of evenings.',
  openGraph: {
    title: `The Story | ${siteConfig.name}`,
    description:
      'How one person built an AI operating system for their whole life -- in two months of evenings.',
    url: `${siteConfig.url}/story`,
    type: 'website',
  },
  alternates: {
    canonical: '/story',
  },
};

export default function StoryLayout({ children }: { children: React.ReactNode }) {
  return children;
}
