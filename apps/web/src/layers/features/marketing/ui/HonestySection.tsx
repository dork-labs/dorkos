/** Radical transparency section — honest about architecture and tradeoffs. */
export function HonestySection() {
  return (
    <section className="py-32 px-8 bg-cream-white">
      <div className="max-w-[600px] mx-auto text-center relative">
        {/* Corner brackets — engineering document aesthetic */}
        <div className="absolute -top-8 -left-8 w-6 h-6 border-l-2 border-t-2 border-warm-gray-light/30" />
        <div className="absolute -top-8 -right-8 w-6 h-6 border-r-2 border-t-2 border-warm-gray-light/30" />
        <div className="absolute -bottom-8 -left-8 w-6 h-6 border-l-2 border-b-2 border-warm-gray-light/30" />
        <div className="absolute -bottom-8 -right-8 w-6 h-6 border-r-2 border-b-2 border-warm-gray-light/30" />

        <span className="font-mono text-2xs tracking-[0.15em] uppercase text-brand-green block mb-10">
          Honest by Design
        </span>

        <p className="text-warm-gray text-lg leading-[1.7] mb-6">
          Claude Code uses Anthropic&apos;s API for inference. Your code context
          is sent to their servers. DorkOS doesn&apos;t change that — and we
          won&apos;t pretend it does.
        </p>

        <p className="text-charcoal font-semibold text-lg leading-[1.7] mb-6">
          Here&apos;s what DorkOS does control.
        </p>

        <p className="text-warm-gray text-lg leading-[1.7]">
          The agent runs on your machine. Sessions are stored locally. Tools
          execute in your shell. The orchestration, the heartbeat, the vault —
          that&apos;s all yours. We believe in honest tools for serious builders.
        </p>
      </div>
    </section>
  )
}
