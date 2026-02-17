import type { UseCase } from '../lib/use-cases'

interface UseCasesGridProps {
  useCases: UseCase[]
}

/** "What This Unlocks" section showing what people can do with DorkOS. */
export function UseCasesGrid({ useCases }: UseCasesGridProps) {
  return (
    <section id="features" className="py-40 px-8 bg-cream-primary">
      <span className="font-mono text-2xs tracking-[0.15em] uppercase text-brand-orange text-center block mb-6">
        What This Unlocks
      </span>

      <p className="text-charcoal text-[28px] md:text-[32px] font-medium tracking-[-0.02em] leading-[1.3] text-center max-w-2xl mx-auto mb-16">
        Not features. Capabilities.
      </p>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8 max-w-5xl mx-auto">
        {useCases.map((uc) => (
          <article key={uc.id} className="text-left">
            <h3 className="text-charcoal font-semibold text-lg tracking-[-0.01em] mb-2">
              {uc.title}
            </h3>
            <p className="text-warm-gray text-sm leading-relaxed">
              {uc.description}
            </p>
          </article>
        ))}
      </div>
    </section>
  )
}
