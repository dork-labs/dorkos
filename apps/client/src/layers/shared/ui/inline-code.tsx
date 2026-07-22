import { cn } from '../lib/utils';

/**
 * Inline monospace code snippet — the one styling for a command, path, or field
 * name mentioned mid-sentence.
 *
 * Sizes relative to the surrounding text (`text-[0.85em]`) so it sits neatly in
 * body copy, fine print, or a heading alike, and wraps mid-token (`break-all`)
 * so a long command or path never forces the line to overflow. For a block-level
 * command with its own copy affordance, use `DependencyInstallHint` instead.
 */
function InlineCode({ className, children, ...props }: React.ComponentProps<'code'>) {
  return (
    <code
      data-slot="inline-code"
      className={cn('bg-muted rounded px-1.5 py-0.5 font-mono text-[0.85em] break-all', className)}
      {...props}
    >
      {children}
    </code>
  );
}

export { InlineCode };
