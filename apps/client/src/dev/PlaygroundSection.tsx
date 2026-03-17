import { Copy, Check } from 'lucide-react';
import { slugify } from './lib/slugify';
import { useCopy } from './lib/use-copy';

interface PlaygroundSectionProps {
  title: string;
  description?: string;
  children: React.ReactNode;
}

/** Reusable section card for the dev playground. */
export function PlaygroundSection({
  title,
  description,
  children,
}: PlaygroundSectionProps) {
  const anchorId = slugify(title);
  const { copied, copy } = useCopy();

  return (
    <section id={anchorId} className="scroll-mt-14 rounded-xl border border-border bg-card p-6">
      <h2 className="group mb-1 flex items-center text-lg font-semibold text-foreground">
        {title}
        <a
          href={`#${anchorId}`}
          className="ml-2 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground"
          aria-label={`Link to ${title}`}
        >
          #
        </a>
        <button
          type="button"
          onClick={() => copy(title)}
          className="ml-1 text-muted-foreground/0 transition-colors group-hover:text-muted-foreground"
          aria-label={`Copy "${title}"`}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </h2>
      {description && (
        <p className="mb-4 text-sm text-muted-foreground">{description}</p>
      )}
      <div className="space-y-6">{children}</div>
    </section>
  );
}
