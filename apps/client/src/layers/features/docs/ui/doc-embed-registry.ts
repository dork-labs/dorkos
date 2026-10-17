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

/**
 * Every Docs embed: `name → { component, validate, title, icon, defaultAttributes }`.
 *
 * A module constant, so every render hands Blintz the same reference and no
 * embed re-renders because its registry was rebuilt. Each validator decodes the
 * attributes and runs the `dorkos-ui` widget schema, so Blintz shows its own
 * error notice, with the issues, for a directive that would not draw.
 */
export const DOC_EMBEDS: EmbedRegistry = Object.fromEntries(
  DOC_EMBED_NAMES.map((name): [string, EmbedDefinition] => {
    const spec = DOC_EMBED_CATALOG[name];
    return [
      name,
      {
        component: DocEmbed,
        validate: (attributes) => validateDocEmbed(name, attributes),
        kind: 'leaf',
        title: spec.title,
        icon: DOC_EMBED_ICONS[name],
        defaultAttributes: { ...spec.example },
      },
    ];
  })
);
