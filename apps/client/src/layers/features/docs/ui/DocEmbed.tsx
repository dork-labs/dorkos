import { useMemo } from 'react';
import type { EmbedProps } from 'blintz';
import { DOC_EMBED_CATALOG, decodeDocEmbed, isDocEmbedName } from '@dorkos/shared/doc-embeds';
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
 * For someone who can edit the doc, Blintz validates first and shows the author
 * what is wrong, so an invalid embed never reaches here. For a reader, it does,
 * and gets {@link DocEmbedUnavailable}: no code, no error text.
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
  if (!result.ok) return <DocEmbedUnavailable name={name} />;
  return (
    <WidgetStillProvider value>
      <figure className="dorkos-doc-embed my-2 text-sm" data-doc-embed={name}>
        <WidgetNodeView node={result.node} path={`doc.${name}`} />
        {label && <figcaption className="text-muted-foreground mt-2 text-xs">{label}</figcaption>}
      </figure>
    </WidgetStillProvider>
  );
}

/**
 * What a reader sees where an embed could not be drawn: one quiet line. The
 * reader can do nothing about the doc's source, so the author's diagnostics
 * stay with people who can edit it.
 *
 * @param name - The directive name; a catalog name reads as its title.
 */
export function DocEmbedUnavailable({ name }: { name: string }) {
  const what = isDocEmbedName(name) ? DOC_EMBED_CATALOG[name].title.toLowerCase() : 'part';
  return (
    <p role="note" className="text-muted-foreground my-2 text-xs italic" data-doc-embed-unavailable>
      {`This ${what} couldn’t be drawn.`}
    </p>
  );
}
