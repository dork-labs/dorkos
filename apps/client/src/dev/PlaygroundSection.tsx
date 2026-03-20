import { Copy, Check } from 'lucide-react';
import { slugify } from './lib/slugify';
import { useCopy } from './lib/use-copy';

interface PlaygroundSectionProps {
  title: string;
  description?: string;
  children: React.ReactNode;
}

/** Reusable section card for the dev playground. */
export function PlaygroundSection({ title, description, children }: PlaygroundSectionProps) {
  const anchorId = slugify(title);
  const { copied, copy } = useCopy();

  return (
    <section id={anchorId} className="border-border bg-card scroll-mt-14 rounded-xl border p-6">
      <h2 className="group text-foreground mb-1 flex items-center text-lg font-semibold">
        {title}
        <a
          href={`#${anchorId}`}
          className="text-muted-foreground/0 group-hover:text-muted-foreground ml-2 transition-colors"
          aria-label={`Link to ${title}`}
        >
          #
        </a>
        <button
          type="button"
          onClick={() => copy(title)}
          className="text-muted-foreground/0 group-hover:text-muted-foreground ml-1 transition-colors"
          aria-label={`Copy "${title}"`}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      </h2>
      {description && <p className="text-muted-foreground mb-4 text-sm">{description}</p>}
      <div className="space-y-6">{children}</div>
    </section>
  );
}
