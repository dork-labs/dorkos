'use client';

import type { ReactNode } from 'react';
import { trackGithubClick } from '@/lib/analytics';

interface FooterSocialLinkProps {
  name: string;
  href: string;
  children: ReactNode;
}

/**
 * One footer social icon link. A client component so the GitHub link can fire
 * the `github_click` funnel event on click — the footer itself stays a server
 * component (event handlers cannot cross the server/client boundary).
 */
export function FooterSocialLink({ name, href, children }: FooterSocialLinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={name === 'GitHub' ? () => trackGithubClick('footer') : undefined}
      className="text-cream-tertiary hover:text-brand-orange transition-smooth"
      aria-label={name}
    >
      {children}
    </a>
  );
}
