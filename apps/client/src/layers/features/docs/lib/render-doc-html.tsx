/**
 * Render a markdown doc to HTML, embeds included, with nothing but string
 * processing and `react-dom/server`.
 *
 * This is the publish half of Docs embeds. It never imports the editor:
 * Blintz's grammar comes from `blintz/markdown`, which carries the remark
 * plugins and the attribute validator with no React editor, ProseMirror or
 * Milkdown behind them. It touches no `window` or `document`, so the same
 * function runs in a browser tab and in Node.
 *
 * Every embed draws through the SAME component the editor shows, from its props
 * alone, after the same validation the editor runs. Markdown is turned into
 * HTML and then sanitized; the embeds are spliced in only after that, because
 * their markup (inline SVG, styles) is the app's own output from validated
 * props, which a generic sanitizer would strip.
 *
 * @module features/docs/lib/render-doc-html
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkRehype, { type Options as RemarkRehypeOptions } from 'remark-rehype';
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize';
import { toHtml } from 'hast-util-to-html';
import { visit, SKIP } from 'unist-util-visit';
import type { Root as MdastRoot, Parent as MdastParent, RootContent } from 'mdast';
import type { Root as HastRoot, Element as HastElement } from 'hast';
import type { EmbedAttributes, EmbedIssue, EmbedRegistry } from 'blintz';
import {
  remarkBlockDirectives,
  remarkWikiLinks,
  validateEmbedAttributes,
  type WikiLinkNode,
} from 'blintz/markdown';
import type { DocEmbedIssue } from '@dorkos/shared/doc-embeds';
import { DOC_EMBEDS } from '../ui/doc-embed-registry';
import { DocEmbedProblem } from '../ui/DocEmbed';

/** Options for {@link renderDocToHtml}. */
export interface RenderDocOptions {
  /** The embeds to draw. Defaults to the Docs embed catalog. */
  embeds?: EmbedRegistry;
}

/** A block directive as `mdast-util-directive` builds it. */
interface DirectiveNode extends MdastParent {
  type: 'leafDirective' | 'containerDirective';
  name: string;
  attributes?: Record<string, string | null | undefined> | null;
}

/**
 * Where a rendered embed goes. Markdown cannot produce this element: raw HTML in
 * a doc is shown as text (as the editor shows it), so the only element of this
 * name in the tree is one this module put there.
 */
const SLOT_TAG = 'dorkos-doc-embed-slot';

/** GitHub's sanitize schema, plus the slot element and its index. */
const SANITIZE_SCHEMA: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), SLOT_TAG],
  attributes: { ...defaultSchema.attributes, [SLOT_TAG]: ['dataSlot'] },
};

/** How the nodes Blintz's grammar adds become HTML. */
const HANDLERS: RemarkRehypeOptions['handlers'] = {
  // Raw HTML shows as written, the way the editor shows it, never as markup.
  html: (_state, node: { value: string }, parent) =>
    parent?.type === 'root'
      ? {
          type: 'element',
          tagName: 'p',
          properties: {},
          children: [{ type: 'text', value: node.value }],
        }
      : { type: 'text', value: node.value },
  // A wiki link has no page to point at outside the app: keep its words.
  wikiLink: (_state, node: WikiLinkNode) => ({ type: 'text', value: node.label ?? node.target }),
  // Frontmatter is the doc's metadata, not its text.
  yaml: () => undefined,
};

/** Text content of a label, without pulling in `mdast-util-to-string`. */
function plainText(nodes: readonly RootContent[]): string {
  return nodes
    .map((node) =>
      'value' in node && typeof node.value === 'string'
        ? node.value
        : 'children' in node
          ? plainText(node.children as RootContent[])
          : ''
    )
    .join('');
}

/** Whether a container's first paragraph is its `[label]`. */
function isLabel(node: RootContent | undefined): boolean {
  return (
    node?.type === 'paragraph' &&
    (node.data as { directiveLabel?: boolean } | undefined)?.directiveLabel === true
  );
}

/** Blintz's issue paths allow symbols and `{ key }` segments; ours are plain. */
function plainIssues(issues: readonly EmbedIssue[]): DocEmbedIssue[] {
  return issues.map((issue) => ({
    message: issue.message,
    path: issue.path?.map((part) => {
      const key = typeof part === 'object' ? part.key : part;
      return typeof key === 'number' ? key : String(key);
    }),
  }));
}

/**
 * Draw one embed the way the editor's embed view does: unknown name → the
 * placeholder, invalid → the issues, valid → the registered component. A
 * component that throws becomes the "can't show this" state, never a failed render.
 */
async function renderEmbed(
  registry: EmbedRegistry,
  name: string,
  attributes: EmbedAttributes,
  label: string
): Promise<string> {
  const definition = Object.prototype.hasOwnProperty.call(registry, name)
    ? registry[name]
    : undefined;
  if (!definition) return renderToStaticMarkup(<DocEmbedProblem name={name} />);
  const { issues } = await validateEmbedAttributes(definition.validate, attributes);
  if (issues?.length) {
    return renderToStaticMarkup(<DocEmbedProblem name={name} issues={plainIssues(issues)} />);
  }
  const Embed = definition.component;
  try {
    return renderToStaticMarkup(
      <Embed name={name} attributes={attributes} label={label} editable={false} />
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return renderToStaticMarkup(<DocEmbedProblem name={name} issues={[{ message }]} />);
  }
}

/**
 * Replace every block directive with a slot (and, for a container, the slot
 * followed by its own markdown, as the editor lays it out), rendering each
 * embed's HTML on the way.
 *
 * @returns The rendered embeds, indexed by slot.
 */
async function renderDirectives(tree: MdastRoot, registry: EmbedRegistry): Promise<string[]> {
  const found: { node: DirectiveNode; index: number; parent: MdastParent }[] = [];
  visit(tree, (node, index, parent) => {
    // Directive node types come from `mdast-util-directive`, which augments
    // mdast only where its types are imported; compare as plain strings.
    const type: string = node.type;
    if (type !== 'leafDirective' && type !== 'containerDirective') return;
    if (parent && index !== undefined) {
      found.push({ node: node as unknown as DirectiveNode, index, parent });
    }
    // A leaf's children are its label. A container's are markdown, which may
    // hold embeds of its own: those are found next, so they are replaced first.
    return type === 'leafDirective' ? SKIP : undefined;
  });

  const rendered = await Promise.all(
    found.map(({ node }) => {
      const attributes: EmbedAttributes = {};
      for (const [key, value] of Object.entries(node.attributes ?? {})) {
        if (typeof value === 'string') attributes[key] = value;
      }
      const children = node.children as RootContent[];
      const label =
        node.type === 'leafDirective'
          ? plainText(children)
          : isLabel(children[0])
            ? plainText([children[0]!])
            : '';
      return renderEmbed(registry, node.name, attributes, label);
    })
  );

  // Back to front, so earlier indexes in a shared parent stay valid.
  for (let slot = found.length - 1; slot >= 0; slot--) {
    const { node, index, parent } = found[slot]!;
    const replacement: unknown[] = [
      { type: 'docEmbedSlot', data: { hName: SLOT_TAG, hProperties: { dataSlot: String(slot) } } },
    ];
    if (node.type === 'containerDirective') {
      const content = (node.children as RootContent[]).filter(
        (child, i) => i > 0 || !isLabel(child)
      );
      if (content.length > 0) {
        replacement.push({ type: 'docEmbedContent', data: { hName: 'div' }, children: content });
      }
    }
    parent.children.splice(index, 1, ...(replacement as RootContent[]));
  }
  return rendered;
}

/** Swap each sanitized slot for its embed's HTML. */
function spliceEmbeds(tree: HastRoot, rendered: readonly string[]): void {
  visit(tree, 'element', (node: HastElement, index, parent) => {
    if (node.tagName !== SLOT_TAG || !parent || index === undefined) return;
    const html = rendered[Number(node.properties.dataSlot)] ?? '';
    parent.children.splice(index, 1, { type: 'raw', value: html });
    return [SKIP, index + 1];
  });
}

/**
 * Render a markdown doc to an HTML fragment (no `<html>` or `<body>`).
 *
 * CommonMark plus GFM, frontmatter left out, Blintz's block directives drawn as
 * embeds and wiki links kept as their words. The markdown's own HTML is
 * sanitized; raw HTML in the doc is shown as text.
 *
 * @param markdown - The doc as stored on disk.
 * @param options - Which embed registry to draw with.
 * @returns The rendered HTML fragment.
 */
export async function renderDocToHtml(
  markdown: string,
  options: RenderDocOptions = {}
): Promise<string> {
  const processor = unified()
    .use(remarkParse)
    .use(remarkFrontmatter)
    .use(remarkGfm)
    // Blintz's grammar before anything that handles paragraphs (its contract).
    .use(remarkBlockDirectives)
    .use(remarkWikiLinks)
    .use(remarkRehype, { handlers: HANDLERS })
    .use(rehypeSanitize, SANITIZE_SCHEMA);

  const mdast = processor.parse(markdown);
  const rendered = await renderDirectives(mdast, options.embeds ?? DOC_EMBEDS);
  const hast = (await processor.run(mdast)) as HastRoot;
  spliceEmbeds(hast, rendered);
  return toHtml(hast, { allowDangerousHtml: true });
}
