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

import { Streamdown } from 'streamdown';
import 'streamdown/styles.css';

interface StreamdownMarkdownProps {
  /** Raw markdown source to render. */
  content: string;
}

/**
 * Render a raw markdown string with the workspace's standard streamdown
 * pipeline. Uses the GitHub light/dark Shiki themes to match the rest of
 * the docs surface.
 */
export function StreamdownMarkdown({ content }: StreamdownMarkdownProps) {
  return <Streamdown shikiTheme={['github-light', 'github-dark']}>{content}</Streamdown>;
}
