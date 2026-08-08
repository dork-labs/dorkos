/**
 * The closed set of node types the composer's editor may create, and the one
 * node this spec adds.
 *
 * @module features/composer/ui/field/lexical-nodes
 */
import { ListItemNode, ListNode } from '@lexical/list';
import { HeadingNode } from '@lexical/rich-text';
import { TextNode, type EditorConfig, type LexicalNode, type NodeKey } from 'lexical';
import type { SerializedTextNode, Spread } from 'lexical';
import { mentionPillVariants } from '@/layers/shared/ui';

/** Who a mention points at. Drives which pill is drawn, and nothing else. */
export type MentionKind = 'human' | 'agent';

/** A `MentionNode` as it survives `exportJSON` → `importJSON`. */
export type SerializedMentionNode = Spread<
  { handle: string; kind: MentionKind; identityColor: string | null },
  SerializedTextNode
>;

/**
 * How much of an agent's own colour tints the pill's text.
 *
 * Kept in step with `shared/ui/mention-pill`'s `AGENT_TEXT_MIX` by hand,
 * because that constant is module-private there. The `hsl()` wrapper below is
 * load-bearing for the same reason it is there: this app's theme tokens store a
 * bare `H S% L%` triple, and `color-mix()` with an unwrapped triple is invalid
 * CSS that the browser drops whole — not just the offending channel.
 */
const AGENT_TEXT_MIX = '65%';

/**
 * The lucide `Bot` glyph, inlined.
 *
 * `createDOM` returns a DOM element and cannot render React, so the one glyph
 * `MentionPill`'s agent branch draws is reproduced by hand from lucide-react
 * v1.21.0's `bot` icon node and its default SVG attributes. The classes match
 * that component's exactly.
 */
const BOT_GLYPH_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"' +
  ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"' +
  ' stroke-linejoin="round" aria-hidden="true"' +
  ' class="mr-0.5 inline-block size-[0.85em] align-[-0.15em]">' +
  '<path d="M12 8V4H8"/>' +
  '<rect width="16" height="12" x="4" y="8" rx="2"/>' +
  '<path d="M2 14h2"/>' +
  '<path d="M20 14h2"/>' +
  '<path d="M15 13v2"/>' +
  '<path d="M9 13v2"/>' +
  '</svg>';

/**
 * One resolved `@mention`, drawn as the identity pill and behaving as one
 * character.
 *
 * **A `TextNode` in token mode, not a decorator.** Its text IS `@handle`, so it
 * serializes through the ordinary text path with no transformer at all — which
 * is exactly why round-trip stability holds for a document containing mentions.
 * `isToken()` is what makes it atomic: backspace deletes the whole pill in one
 * press, the caret never lands inside it, and typing against it does not extend
 * it.
 *
 * **The editor never becomes the resolver.** This node draws what the host
 * already told it. A handle the host did not list stays plain text, and the
 * server still decides who a mention addresses at write time.
 */
export class MentionNode extends TextNode {
  /** The handle this mention was typed as, without the leading `@`. */
  readonly __handle: string;
  /** Whether this mention points at a person or an agent. */
  readonly __kind: MentionKind;
  /** The agent's identity colour, or `null` for a human. */
  readonly __identityColor: string | null;

  /**
   * Build a mention whose text is `@handle`.
   *
   * @param handle - The handle, without its leading `@`.
   * @param kind - Whether the mention points at a person or an agent.
   * @param identityColor - The agent's identity colour; `null` for a human.
   * @param key - Lexical's node key.
   */
  constructor(
    handle: string,
    kind: MentionKind,
    identityColor: string | null = null,
    key?: NodeKey
  ) {
    super(`@${handle}`, key);
    this.__handle = handle;
    this.__kind = kind;
    this.__identityColor = identityColor;
  }

  /** Lexical's type tag for this node class. */
  static getType(): string {
    return 'composer-mention';
  }

  /**
   * Copy a node, preserving its key.
   *
   * @param node - The node to clone.
   * @returns The clone.
   */
  static clone(node: MentionNode): MentionNode {
    return new MentionNode(node.__handle, node.__kind, node.__identityColor, node.__key);
  }

  /**
   * Rebuild a node from its serialized form.
   *
   * @param serialized - The serialized node.
   * @returns The rebuilt node.
   */
  static importJSON(serialized: SerializedMentionNode): MentionNode {
    return new MentionNode(
      serialized.handle,
      serialized.kind,
      serialized.identityColor
    ).updateFromJSON(serialized);
  }

  /** Serialize, carrying the three facts `createDOM` needs to redraw the pill. */
  exportJSON(): SerializedMentionNode {
    return {
      ...super.exportJSON(),
      handle: this.__handle,
      kind: this.__kind,
      identityColor: this.__identityColor,
    };
  }

  /** Token mode: the pill is one character as far as the caret is concerned. */
  isToken(): boolean {
    return true;
  }

  /**
   * Draw the pill `MentionPill` would draw for the same identity.
   *
   * @param config - Lexical's editor config, for the base text styling.
   * @returns The pill element.
   */
  createDOM(config: EditorConfig): HTMLElement {
    const element = super.createDOM(config);
    const isAgent = this.__kind === 'agent';

    element.className = mentionPillVariants({
      tone: isAgent ? 'agent' : 'neutral',
      interactive: false,
    });
    element.setAttribute('data-slot', 'mention-pill');
    element.setAttribute('data-kind', this.__kind);
    element.setAttribute('title', `@${this.__handle}`);

    if (isAgent) {
      const color = this.__identityColor ?? 'currentColor';
      // Published, not painted: the background lives in the class that reads
      // this custom property, so an inline `background-color` would beat every
      // stylesheet rule and break the hover step.
      element.style.setProperty('--identity-color', color);
      element.style.color = `color-mix(in oklch, ${color} ${AGENT_TEXT_MIX}, hsl(var(--foreground)))`;
      element.insertAdjacentHTML('afterbegin', BOT_GLYPH_SVG);
    }

    return element;
  }

  /**
   * Redraw only when something the pill actually shows has changed.
   *
   * @param prevNode - The previous version of this node.
   * @param dom - The element currently drawn.
   * @param config - Lexical's editor config.
   * @returns Whether Lexical must recreate the element.
   */
  updateDOM(prevNode: this, dom: HTMLElement, config: EditorConfig): boolean {
    if (
      prevNode.__handle !== this.__handle ||
      prevNode.__kind !== this.__kind ||
      prevNode.__identityColor !== this.__identityColor
    ) {
      return true;
    }
    return super.updateDOM(prevNode, dom, config);
  }
}

/**
 * Whether `node` is a {@link MentionNode}.
 *
 * @param node - Any node.
 * @returns `true` when it is a mention.
 */
export function $isMentionNode(node: LexicalNode | null | undefined): node is MentionNode {
  return node instanceof MentionNode;
}

/**
 * Build a mention for `handle`.
 *
 * @param handle - The handle, without its leading `@`.
 * @param kind - Whether the mention points at a person or an agent.
 * @param identityColor - The agent's identity colour; `null` for a human.
 * @returns The node.
 */
export function $createMentionNode(
  handle: string,
  kind: MentionKind,
  identityColor: string | null = null
): MentionNode {
  return new MentionNode(handle, kind, identityColor);
}

/**
 * Every node class the composer's editor may create. A closed set.
 *
 * `HeadingNode` and the two list nodes must be registered or their transformers
 * silently do nothing — a `# ` that never becomes a heading and no error to say
 * why.
 */
export const COMPOSER_NODES = [HeadingNode, ListNode, ListItemNode, MentionNode];
