import type { Metadata } from 'next';
import { siteConfig } from '@/config/site';
import { rssFeedAlternateTypes } from '@/lib/metadata';

export const metadata: Metadata = {
  title: `The Story | ${siteConfig.name}`,
  description:
    'How DorkOS started: one founder, an agent team, and the bet that one person with good help can build and run a whole business.',
  openGraph: {
    title: `The Story | ${siteConfig.name}`,
    description:
      'How DorkOS started: one founder, an agent team, and the bet that one person with good help can build and run a whole business.',
    url: `${siteConfig.url}/story`,
    type: 'website',
  },
  alternates: {
    canonical: '/story',
    types: rssFeedAlternateTypes,
  },
};

export default function StoryLayout({ children }: { children: React.ReactNode }) {
  return children;
}
