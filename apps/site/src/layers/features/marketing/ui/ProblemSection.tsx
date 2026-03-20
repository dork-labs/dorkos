/** Antagonist framing section — cloud vs. local positioning. */
export function ProblemSection() {
  return (
    <section className="bg-cream-tertiary px-8 py-32">
      <div className="relative mx-auto max-w-[600px] text-center">
        {/* Corner brackets — engineering document aesthetic */}
        <div className="border-warm-gray-light/30 absolute -top-8 -left-8 h-6 w-6 border-t-2 border-l-2" />
        <div className="border-warm-gray-light/30 absolute -top-8 -right-8 h-6 w-6 border-t-2 border-r-2" />
        <div className="border-warm-gray-light/30 absolute -bottom-8 -left-8 h-6 w-6 border-b-2 border-l-2" />
        <div className="border-warm-gray-light/30 absolute -right-8 -bottom-8 h-6 w-6 border-r-2 border-b-2" />

        <p className="text-warm-gray mb-6 text-lg leading-[1.7]">
          Every AI coding interface you&apos;ve used lives in someone else&apos;s cloud. Their
          servers. Their logs. Their uptime. Their rules.
        </p>

        <p className="text-charcoal mb-6 text-lg leading-[1.7] font-semibold">
          DorkOS is different.
        </p>

        <p className="text-warm-gray text-lg leading-[1.7]">
          It runs on your machine. You access it from any browser. Your sessions, your transcripts,
          your infrastructure.
        </p>
      </div>
    </section>
  );
}
