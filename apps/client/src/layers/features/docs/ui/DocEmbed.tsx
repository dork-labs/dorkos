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
 * The inline "can't show this" state: for an embed whose attributes do not
 * decode, or, with no `issues`, for a name nothing is registered under.
 *
 * @param name - The directive name as written.
 * @param issues - What is wrong; omit for a name with no component.
 */
export function DocEmbedProblem({
  name,
  issues,
}: {
  name: string;
  issues?: readonly DocEmbedIssue[];
}) {
  const title = isDocEmbedName(name) ? DOC_EMBED_CATALOG[name].title.toLowerCase() : name;
  return (
    <div
      role="note"
      className="text-muted-foreground my-2 rounded-md border border-dashed p-3 text-xs"
      data-doc-embed-problem={name}
    >
      <p className="text-foreground font-medium">
        {issues ? `Can’t show this ${title}` : `No embed called “${name}”`}
      </p>
      {issues ? (
        <ul className="mt-1 list-disc pl-4">
          {issues.map((issue, index) => (
            <li key={index}>{formatIssue(issue)}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-1">It stays in the doc as written.</p>
      )}
    </div>
  );
}
