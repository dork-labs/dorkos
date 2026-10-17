import { useMemo } from 'react';
import type { EmbedProps } from 'blintz';
import {
  DOC_EMBED_CATALOG,
  decodeDocEmbed,
  isDocEmbedName,
  type DocEmbedIssue,
} from '@dorkos/shared/doc-embeds';
import { WidgetNodeView, WidgetStillProvider } from '@/layers/features/gen-ui';

/**
 * One Docs embed: a `::chart{…}` (or any catalog name) directive drawn with the
 * gen-UI node component a `dorkos-ui` fence would use for the same node.
 *
 * It renders from its props alone — no store, no transport, no `window` — so the
 * same component runs inside the editor and through `react-dom/server` when a
 * doc is rendered to HTML. There is no widget action provider above it, so
 * nothing in it can act; and it renders still, because a doc re-renders far
 * more often than a chat reply arrives.
 *
 * The editor validates before it renders, so in the editor an invalid embed
 * never reaches here. The invalid state is still handled for any other caller.
 *
 * @param props - The directive as Blintz passes it: name, string attributes and
 *   the `[label]`, shown as a caption.
 */
export function DocEmbed({ name, attributes, label }: EmbedProps) {
  // Attributes arrive as a fresh object per render; decode once per content.
  const key = JSON.stringify(attributes);
  const result = useMemo(
    () => decodeDocEmbed(name, JSON.parse(key) as Record<string, string>),
    [name, key]
  );
  if (!result.ok) return <DocEmbedProblem name={name} issues={result.issues} />;
  return (
    <WidgetStillProvider value>
      <figure className="dorkos-doc-embed my-2 text-sm" data-doc-embed={name}>
        <WidgetNodeView node={result.node} path={`doc.${name}`} />
        {label && <figcaption className="text-muted-foreground mt-2 text-xs">{label}</figcaption>}
      </figure>
    </WidgetStillProvider>
  );
}

/** Blintz's `path: message` form, so both notices read alike. */
function formatIssue(issue: DocEmbedIssue): string {
  const path = issue.path?.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

/**
 * The author's "can't show this" state for an embed whose attributes do not
 * decode, with what is wrong.
 *
 * @param name - The directive name as written.
 * @param issues - What is wrong.
 */
export function DocEmbedProblem({
  name,
  issues,
}: {
  name: string;
  issues: readonly DocEmbedIssue[];
}) {
  const title = isDocEmbedName(name) ? DOC_EMBED_CATALOG[name].title.toLowerCase() : name;
  return (
    <div
      role="note"
      className="text-muted-foreground my-2 rounded-md border border-dashed p-3 text-xs"
      data-doc-embed-problem={name}
    >
      <p className="text-foreground font-medium">{`Can’t show this ${title}`}</p>
      <ul className="mt-1 list-disc pl-4">
        {issues.map((issue, index) => (
          <li key={index}>{formatIssue(issue)}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What a reader of a saved or published doc sees where an embed could not be
 * drawn. Quiet and neutral on purpose: the reader can do nothing about the
 * doc's source, so the author's diagnostics stay in the editor.
 */
export function DocEmbedUnavailable() {
  return (
    <p role="note" className="text-muted-foreground my-2 text-xs italic" data-doc-embed-unavailable>
      This part of the doc can’t be shown here.
    </p>
  );
}
