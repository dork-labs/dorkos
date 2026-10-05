import { FolderGit2 } from 'lucide-react';
import { cn } from '@/layers/shared/lib/utils';
import { Badge } from './badge';

/** Props for {@link DevLinkTag}. */
export interface DevLinkTagProps {
  /** Extra classes for the tag. */
  className?: string;
}

/**
 * The "Dev link" tag beside a package or extension name (DOR-2696): it runs
 * straight from a folder on this computer. Quiet on purpose, muted and
 * outlined with no alarm colour, because the person chose this.
 */
export function DevLinkTag({ className }: DevLinkTagProps) {
  return (
    <Badge variant="outline" size="xs" className={cn('text-muted-foreground', className)}>
      Dev link
    </Badge>
  );
}

/** Props for {@link DevLinkPath}. */
export interface DevLinkPathProps {
  /** The real path of the folder the package runs from. */
  path: string;
  /** Extra classes for the line. */
  className?: string;
}

/**
 * The "Dev link: <path>" line under a dev-linked package or extension. The
 * path is monospace and wraps anywhere, so a long folder path never pushes a
 * phone layout sideways. Data-free: each surface passes the path it has.
 */
export function DevLinkPath({ path, className }: DevLinkPathProps) {
  return (
    <p
      data-slot="dev-link-path"
      className={cn('text-muted-foreground flex min-w-0 items-start gap-1 text-xs', className)}
    >
      <FolderGit2 className="mt-0.5 size-3 shrink-0" aria-hidden />
      <span className="min-w-0">
        Dev link: <code className="font-mono [overflow-wrap:anywhere]">{path}</code>
      </span>
    </p>
  );
}
