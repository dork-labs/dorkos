import { Copy, Check, X } from 'lucide-react';
import { useCopyFeedback } from '@/layers/shared/lib';
import { slugify } from './lib/slugify';
import { ShowcaseErrorBoundary } from './ShowcaseErrorBoundary';

interface PlaygroundSectionProps {
  title: string;
  description?: string;
  children: React.ReactNode;
}

/** The title's copy icon: a check on success, an X on failure, the glyph otherwise. */
function TitleCopyIcon({ copied, failed }: { copied: boolean; failed: boolean }) {
  if (copied) return <Check className="size-3.5" />;
  if (failed) return <X className="text-destructive size-3.5" />;
  return <Copy className="size-3.5" />;
}

/** Reusable section card for the dev playground. */
export function PlaygroundSection({ title, description, children }: PlaygroundSectionProps) {
  const anchorId = slugify(title);
  const { copied, failed, copy } = useCopyFeedback();

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
          onClick={() => void copy(title)}
          className="text-muted-foreground/0 group-hover:text-muted-foreground ml-1 transition-colors"
          aria-label={failed ? `Couldn't copy "${title}" — try again` : `Copy "${title}"`}
        >
          <TitleCopyIcon copied={copied} failed={failed} />
        </button>
      </h2>
      {description && <p className="text-muted-foreground mb-4 text-sm">{description}</p>}
      <ShowcaseErrorBoundary name={title}>
        <div className="space-y-6">{children}</div>
      </ShowcaseErrorBoundary>
    </section>
  );
}
