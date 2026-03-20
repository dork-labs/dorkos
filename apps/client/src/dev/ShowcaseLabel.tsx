import { Copy, Check } from 'lucide-react';
import { useCopy } from './lib/use-copy';

/** Shared sub-label for demo sections in the dev playground. */
export function ShowcaseLabel({ children }: { children: string }) {
  const { copied, copy } = useCopy();

  return (
    <div className="group/label text-muted-foreground mb-2 flex items-center text-xs font-medium tracking-wider uppercase">
      {children}
      <button
        type="button"
        onClick={() => copy(children)}
        className="text-muted-foreground/0 group-hover/label:text-muted-foreground ml-1.5 transition-colors"
        aria-label={`Copy "${children}"`}
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      </button>
    </div>
  );
}
