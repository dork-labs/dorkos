import Link from 'next/link'
import { PhilosophyCard } from './PhilosophyCard'
import type { PhilosophyItem } from '../lib/types'

interface AboutSectionProps {
  bylineText?: string
  bylineHref?: string
  description: string
  philosophyItems?: PhilosophyItem[]
}

/** Merged About + Origin section with philosophy grid and closing line. */
export function AboutSection({
  bylineText = 'by Dork Labs',
  bylineHref = 'https://github.com/dork-labs/dorkos',
  description,
  philosophyItems = [],
}: AboutSectionProps) {
  return (
    <section id="about" className="py-40 px-8 bg-cream-white text-center">
      <span className="font-mono text-2xs tracking-[0.15em] uppercase text-charcoal block mb-16">
        About
      </span>

      <p className="text-charcoal text-[32px] font-medium tracking-[-0.02em] leading-[1.3] max-w-3xl mx-auto mb-6">
        DorkOS is an autonomous agent operating system{' '}
        <Link
          href={bylineHref}
          target="_blank"
          rel="noopener noreferrer"
          className="text-brand-orange hover:text-brand-green transition-smooth"
        >
          {bylineText}
        </Link>
        .
      </p>

      <p className="text-warm-gray text-base leading-[1.7] max-w-xl mx-auto mb-20">
        {description}
      </p>

      {philosophyItems.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-12 max-w-4xl mx-auto mb-16">
          {philosophyItems.map((item) => (
            <PhilosophyCard key={item.number} item={item} />
          ))}
        </div>
      )}

      <p className="text-warm-gray-light text-lg leading-[1.7] italic">
        The name is playful. The tool is serious.
      </p>
    </section>
  )
}
