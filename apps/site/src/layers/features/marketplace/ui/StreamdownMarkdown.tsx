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

type ReadmeLinkProps = ComponentProps<'a'> & ExtraProps;

/**
 * Render a README link as a real `<a href>`.
 *
 * **Why this exists (DOR-1296).** Streamdown's own bundled `a` component
 * reads `linkSafety` off context and, whenever it is enabled, renders an
 * `appearance-none` `<button>` in the anchor's place — and `linkSafety`
 * **defaults to `{ enabled: true }` inside Streamdown**, so a caller that
 * never mentions the prop still gets the button (verified here by rendering
 * the pinned version, not inferred; the same default cost the app DOR-1272).
 * A button has no `href`: hovering shows no destination, ⌘/ctrl-click and
 * middle-click have nothing to open, "Copy Link Address" has no link to copy,
 * and — this being a public marketing page — a search engine sees no link at
 * all. Passing this component as `components={{ a: … }}` means Streamdown's
 * own anchor never mounts and its default is never in play.
 *
 * **No confirmation step, unlike the app.** `apps/client`'s `MarkdownLink`
 * confirms an unmodified click, because there a link is written by an agent
 * mid-conversation and can reach an OS protocol handler through the desktop
 * shell. This is a public web page whose links a reader chose to visit: the
 * browser is the only thing dispatching them, and Streamdown's sanitizer has
 * already stripped `javascript:`/`data:`/`vbscript:` before an anchor exists.
 * A modal here would be friction with nothing behind it. The two surfaces
 * differ on purpose — see `contributing/link-dispatch-policy.md`.
 *
 * `rel` carries `nofollow ugc` beside `noopener noreferrer`: a package's
 * README is fetched from the author's own repository at build/ISR time and
 * can change after the package was listed, so its links are third-party
 * user content and must not pass dorkos.ai's ranking on to wherever they
 * happen to point.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- node is streamdown's hast AST node; discarded so it never spreads onto the real DOM element
function ReadmeLink({ className, node: _node, ...props }: ReadmeLinkProps) {
  return (
    <a
      data-streamdown="link"
      {...props}
      // Streamdown's own default classes for a link, minus the two that only
      // made sense on the button it used to render (`appearance-none`,
      // `text-left`) — so this fix changes no visible styling.
      className={cn('text-primary font-medium wrap-anywhere underline', className)}
      target="_blank"
      rel="nofollow ugc noopener noreferrer"
    />
  );
}

/**
 * The component overrides every README render uses.
 *
 * Headings are demoted one level (h1→h2, h2→h3, h3→h4, h4→h5, h5→h6) so two
 * different source levels never collapse onto the same tag. A README's
 * leading `# <name>` would otherwise render as a real `<h1>` competing with
 * the page's own title heading — see `PackageReadme`, the only current
 * caller, which sits below a page that renders its own `<h1>`. h6 is left
 * alone: it is already streamdown's deepest level, so there is nowhere lower
 * to demote it to.
 *
 * `a` is {@link ReadmeLink}, which replaces the hrefless `<button>`
 * streamdown renders by default with a real anchor.
 */
const readmeComponents: Components = {
  h1: demotedHeading('h2', 'text-2xl'),
  h2: demotedHeading('h3', 'text-xl'),
  h3: demotedHeading('h4', 'text-lg'),
  h4: demotedHeading('h5', 'text-base'),
  h5: demotedHeading('h6', 'text-sm'),
  a: ReadmeLink,
};

/**
 * Render a raw markdown string with the workspace's standard streamdown
 * pipeline. Uses the GitHub light/dark Shiki themes to match the rest of
 * the docs surface.
 */
export function StreamdownMarkdown({ content }: StreamdownMarkdownProps) {
  return (
    <Streamdown shikiTheme={['github-light', 'github-dark']} components={readmeComponents}>
      {content}
    </Streamdown>
  );
}
