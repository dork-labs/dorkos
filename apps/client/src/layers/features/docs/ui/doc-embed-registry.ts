/**
 * The Docs embed registry Blintz's `<MarkdownEditor embeds>` takes, built from
 * the shared catalog (`@dorkos/shared/doc-embeds`) so the editor, the slash
 * menu and the HTML renderer all read one list.
 *
 * @module features/docs/ui/doc-embed-registry
 */
import type { EmbedDefinition, EmbedRegistry } from 'blintz';
import { DOC_EMBED_CATALOG, DOC_EMBED_NAMES, validateDocEmbed } from '@dorkos/shared/doc-embeds';
import { DOC_EMBED_ICONS } from '../lib/embed-icons';
import { DocEmbed } from './DocEmbed';

/** One registry entry, with or without the author-facing validator. */
function definitionFor(
  name: (typeof DOC_EMBED_NAMES)[number],
  forAuthors: boolean
): EmbedDefinition {
  const spec = DOC_EMBED_CATALOG[name];
  return {
    component: DocEmbed,
    ...(forAuthors ? { validate: (attributes) => validateDocEmbed(name, attributes) } : {}),
    kind: 'leaf',
    title: spec.title,
    icon: DOC_EMBED_ICONS[name],
    defaultAttributes: { ...spec.example },
  };
}

/**
 * Every Docs embed, for someone who can edit the doc:
 * `name → { component, validate, title, icon, defaultAttributes }`.
 *
 * A module constant, so every render hands Blintz the same reference and no
 * embed re-renders because its registry was rebuilt. Each validator decodes the
 * attributes and runs the `dorkos-ui` widget schema, so Blintz shows the author
 * its error notice, with the issues, for a directive that would not draw.
 */
export const DOC_EMBEDS: EmbedRegistry = Object.fromEntries(
  DOC_EMBED_NAMES.map((name) => [name, definitionFor(name, true)])
);

/**
 * The same embeds for a reader who cannot edit the doc: no validator, so Blintz
 * never shows the author's notice, and an embed that does not decode draws as
 * {@link DocEmbed}'s quiet line instead.
 */
export const DOC_EMBEDS_FOR_READERS: EmbedRegistry = Object.fromEntries(
  DOC_EMBED_NAMES.map((name) => [name, definitionFor(name, false)])
);
