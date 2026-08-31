'use client';

/**
 * StreamdownMarkdown — thin client-side wrapper around `streamdown` so that
 * server components can render raw markdown strings without leaking the
 * `'use client'` boundary up the tree.
 *
 * Streamdown is the workspace's standard markdown renderer (used in
 * `apps/client` for chat and canvas) and ships its own Tailwind-aware styles.
 * Imported here behind a `'use client'` directive because streamdown relies on
 * client-side React.
 *
 * @module features/marketplace/ui/StreamdownMarkdown
 */

import type { ComponentProps, ComponentType } from 'react';
import type { Components, ExtraProps } from 'streamdown';
import { Streamdown } from 'streamdown';
import 'streamdown/styles.css';

import { cn } from '@/lib/utils';

interface StreamdownMarkdownProps {
  /** Raw markdown source to render. */
  content: string;
}

type DemotedHeadingProps = ComponentProps<'h1'> & ExtraProps;

/**
 * Build a component that renders `tag` carrying streamdown's own default
 * classes for that tag (`mt-6 mb-2 font-semibold text-{size}` — every one of
 * streamdown's heading levels shares the same spacing/weight and differs
 * only in size). Handing `components` a bare tag-name string, as this file
 * used to, skips streamdown's default renderer entirely and drops those
 * classes, crowding the heading against the paragraph above it — this keeps
 * them.
 */
function demotedHeading(
  tag: 'h2' | 'h3' | 'h4' | 'h5' | 'h6',
  sizeClass: string
): ComponentType<DemotedHeadingProps> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- node is streamdown's hast AST node; discarded so it never spreads onto the real DOM element
  function DemotedHeading({ className, node: _node, ...props }: DemotedHeadingProps) {
    const Tag = tag;
    return <Tag className={cn('mt-6 mb-2 font-semibold', sizeClass, className)} {...props} />;
  }
  DemotedHeading.displayName = `DemotedHeading(${tag})`;
  return DemotedHeading;
}

/**
 * Demote every rendered heading one level (h1→h2, h2→h3, h3→h4, h4→h5,
 * h5→h6) so two different source levels never collapse onto the same tag. A
 * README's leading `# <name>` would otherwise render as a real `<h1>`
 * competing with the page's own title heading — see `PackageReadme`, the
 * only current caller, which sits below a page that renders its own `<h1>`.
 * h6 is left alone: it is already streamdown's deepest level, so there is
 * nowhere lower to demote it to.
 */
const headingDemotedComponents: Components = {
  h1: demotedHeading('h2', 'text-2xl'),
  h2: demotedHeading('h3', 'text-xl'),
  h3: demotedHeading('h4', 'text-lg'),
  h4: demotedHeading('h5', 'text-base'),
  h5: demotedHeading('h6', 'text-sm'),
};

/**
 * Render a raw markdown string with the workspace's standard streamdown
 * pipeline. Uses the GitHub light/dark Shiki themes to match the rest of
 * the docs surface.
 */
export function StreamdownMarkdown({ content }: StreamdownMarkdownProps) {
  return (
    <Streamdown shikiTheme={['github-light', 'github-dark']} components={headingDemotedComponents}>
      {content}
    </Streamdown>
  );
}
