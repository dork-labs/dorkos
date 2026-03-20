import Link from 'next/link';
import { DorkLogo } from '@dorkos/icons/logos';

interface SocialLink {
  name: string;
  href: string;
  icon: React.ReactNode;
}

interface MarketingFooterProps {
  bylineText?: string;
  bylineHref?: string;
  email: string;
  socialLinks?: SocialLink[];
}

export function MarketingFooter({
  bylineText = 'by Dorian Collier',
  bylineHref = 'https://doriancollier.com',
  email,
  socialLinks = [],
}: MarketingFooterProps) {
  return (
    <>
      {/* Retro brand stripes */}
      <div>
        <div className="bg-brand-orange h-1" />
        <div className="bg-brand-green h-1" />
      </div>

      <footer className="bg-charcoal px-8 py-20 pb-40 text-center">
        {/* Logo */}
        <Link href="/" className="mb-1.5 inline-block">
          <DorkLogo variant="white" size={40} className="mx-auto h-10 w-auto" />
        </Link>

        {/* Tagline */}
        <p className="text-2xs text-cream-tertiary mb-2 font-mono tracking-[0.15em] uppercase">
          DorkOS
        </p>

        {/* Byline */}
        <a
          href={bylineHref}
          target="_blank"
          rel="noopener noreferrer"
          className="text-2xs text-brand-orange hover:text-cream-white transition-smooth mb-8 block font-mono tracking-[0.1em]"
        >
          {bylineText}
        </a>

        {/* Tagline - mission */}
        <p className="text-2xs text-cream-tertiary/60 mb-8 font-mono tracking-[0.12em] uppercase">
          You slept. They shipped.
        </p>

        {/* Social icons */}
        {socialLinks.length > 0 && (
          <div className="mb-5 flex justify-center gap-5">
            {socialLinks.map((link) => (
              <a
                key={link.name}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-cream-tertiary hover:text-brand-orange transition-smooth"
                aria-label={link.name}
              >
                {link.icon}
              </a>
            ))}
          </div>
        )}

        {/* Email */}
        <a
          href={`mailto:${email}`}
          className="text-2xs text-cream-tertiary hover:text-brand-orange transition-smooth font-mono"
        >
          {email}
        </a>
      </footer>
    </>
  );
}
