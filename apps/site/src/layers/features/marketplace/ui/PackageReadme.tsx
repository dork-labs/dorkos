/**
 * PackageReadme — server-rendered README block for the marketplace package
 * detail page.
 *
 * Receives raw markdown text (typically the package's `README.md` fetched at
 * build/ISR time) and delegates rendering to the `StreamdownMarkdown` client
 * subcomponent. Streamdown is the workspace's standard markdown renderer
 * (also used by `apps/client` for chat and canvas content) and is the only
 * raw-string markdown pipeline available in apps/site — Fumadocs MDX requires
 * pre-compiled MDX, which is the wrong fit for runtime-fetched READMEs.
 *
 * Empty markdown renders nothing.
 *
 * @module features/marketplace/ui/PackageReadme
 */

import { StreamdownMarkdown } from './StreamdownMarkdown';

interface PackageReadmeProps {
  /** Raw markdown content of the package's README. */
  markdown: string;
}

/**
 * Render the README markdown for a marketplace package. Returns `null` for
 * empty input so the section disappears entirely when no README is available.
 */
export function PackageReadme({ markdown }: PackageReadmeProps) {
  if (!markdown) return null;
  return (
    <section className="[&_a]:text-charcoal [&_code]:text-charcoal [&_h2]:text-charcoal [&_h3]:text-charcoal [&_h4]:text-charcoal [&_h5]:text-charcoal [&_h6]:text-charcoal [&_li]:text-warm-gray [&_p]:text-warm-gray [&_strong]:text-charcoal mb-10 max-w-none [&_a]:underline [&_h2]:font-mono [&_h2]:text-2xl [&_h2]:font-semibold [&_h3]:font-mono [&_h3]:text-xl [&_h3]:font-semibold [&_h4]:font-mono [&_h4]:text-lg [&_h4]:font-semibold [&_h5]:font-mono [&_h5]:text-base [&_h5]:font-semibold [&_h6]:font-mono [&_h6]:text-sm [&_h6]:font-semibold [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:leading-relaxed [&_strong]:font-semibold [&_ul]:list-disc [&_ul]:pl-5 [&>*]:mb-4">
      <StreamdownMarkdown content={markdown} />
    </section>
  );
}
