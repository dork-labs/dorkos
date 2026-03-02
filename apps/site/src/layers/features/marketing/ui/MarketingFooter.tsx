import Link from 'next/link'
import { DorkLogo } from '@dorkos/icons/logos'

interface SocialLink {
  name: string
  href: string
  icon: React.ReactNode
}

interface MarketingFooterProps {
  bylineText?: string
  bylineHref?: string
  email: string
  socialLinks?: SocialLink[]
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
        <div className="h-1 bg-brand-orange" />
        <div className="h-1 bg-brand-green" />
      </div>

      <footer className="py-20 pb-40 px-8 text-center bg-charcoal">
        {/* Logo */}
        <Link href="/" className="inline-block mb-1.5">
          <DorkLogo variant="white" size={40} className="h-10 w-auto mx-auto" />
        </Link>

        {/* Tagline */}
        <p className="font-mono text-2xs tracking-[0.15em] uppercase text-cream-tertiary mb-2">
          DorkOS
        </p>

        {/* Byline */}
        <a
          href={bylineHref}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-2xs tracking-[0.1em] text-brand-orange hover:text-cream-white transition-smooth block mb-8"
        >
          {bylineText}
        </a>

        {/* Tagline - mission */}
        <p className="font-mono text-2xs tracking-[0.12em] uppercase text-cream-tertiary/60 mb-8">
          You slept. They shipped.
        </p>

        {/* Social icons */}
        {socialLinks.length > 0 && (
          <div className="flex justify-center gap-5 mb-5">
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
          className="font-mono text-2xs text-cream-tertiary hover:text-brand-orange transition-smooth"
        >
          {email}
        </a>

      </footer>
    </>
  )
}
