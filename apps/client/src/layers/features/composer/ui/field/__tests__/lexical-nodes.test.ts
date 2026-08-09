// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { $createParagraphNode, $getRoot, createEditor, type LexicalEditor } from 'lexical';
import { mentionPillVariants } from '@/layers/shared/ui';
import { $createMentionNode, $isMentionNode, COMPOSER_NODES, MentionNode } from '../lexical-nodes';

let root: HTMLElement | null = null;

/**
 * A real editor reconciling into a real element, so the assertions read the DOM
 * Lexical actually produces rather than a hand-called `createDOM`.
 *
 * @returns The editor and the element it draws into.
 */
function mountEditor(): { editor: LexicalEditor; container: HTMLElement } {
  const container = document.createElement('div');
  container.contentEditable = 'true';
  document.body.appendChild(container);
  root = container;
  const editor = createEditor({
    namespace: 'composer-test',
    nodes: COMPOSER_NODES,
    onError: (error) => {
      throw error;
    },
  });
  editor.setRootElement(container);
  return { editor, container };
}

/** Put one mention in the document and return the pill it drew. */
function drawMention(
  handle: string,
  kind: 'human' | 'agent',
  color: string | null = null
): HTMLElement {
  const { editor, container } = mountEditor();
  editor.update(
    () => {
      $getRoot()
        .clear()
        .append($createParagraphNode().append($createMentionNode(handle, kind, color)));
    },
    { discrete: true }
  );
  const pill = container.querySelector<HTMLElement>('[data-slot="mention-pill"]');
  expect(pill).not.toBeNull();
  return pill!;
}

afterEach(() => {
  root?.remove();
  root = null;
});

describe('MentionNode', () => {
  it('draws an agent mention as the identity pill the shared component draws', () => {
    const pill = drawMention('ana', 'agent', '#7c5cff');

    expect(new Set(pill.className.split(/\s+/).filter(Boolean))).toEqual(
      new Set(
        mentionPillVariants({ tone: 'agent', interactive: false }).split(/\s+/).filter(Boolean)
      )
    );
    expect(pill.getAttribute('data-slot')).toBe('mention-pill');
    expect(pill.getAttribute('data-kind')).toBe('agent');
    expect(pill.getAttribute('title')).toBe('@ana');
    expect(pill.style.getPropertyValue('--identity-color')).toBe('#7c5cff');
  });

  // The `hsl()` wrapper is load-bearing: the theme stores a bare `H S% L%`
  // triple, and `color-mix()` with an unwrapped triple is invalid CSS the
  // browser drops whole.
  it('mixes the agent text colour toward the theme foreground, hsl-wrapped', () => {
    const pill = drawMention('ana', 'agent', '#7c5cff');
    expect(pill.style.color).toContain('color-mix(in oklch, #7c5cff 65%, hsl(var(--foreground)))');
  });

  it('gives an agent mention the Bot glyph, hidden from assistive tech', () => {
    const pill = drawMention('ana', 'agent', '#7c5cff');
    const glyph = pill.querySelector('svg');
    expect(glyph).not.toBeNull();
    expect(glyph!.getAttribute('aria-hidden')).toBe('true');
    expect(glyph!.getAttribute('class')).toBe('mr-0.5 inline-block size-[0.85em] align-[-0.15em]');
  });

  it('draws a human mention as the neutral pill with no colour and no glyph', () => {
    const pill = drawMention('kai', 'human');

    expect(new Set(pill.className.split(/\s+/).filter(Boolean))).toEqual(
      new Set(
        mentionPillVariants({ tone: 'neutral', interactive: false }).split(/\s+/).filter(Boolean)
      )
    );
    expect(pill.getAttribute('data-kind')).toBe('human');
    expect(pill.style.getPropertyValue('--identity-color')).toBe('');
    expect(pill.style.color).toBe('');
    expect(pill.querySelector('svg')).toBeNull();
  });

  it.each([
    ['agent' as const, '#7c5cff'],
    ['human' as const, null],
  ])('carries @handle as its own text (%s)', (kind, color) => {
    const { editor } = mountEditor();
    let text = '';
    editor.update(
      () => {
        const node = $createMentionNode('ana', kind, color);
        $getRoot().clear().append($createParagraphNode().append(node));
        text = node.getTextContent();
      },
      { discrete: true }
    );
    expect(text).toBe('@ana');
  });

  it('is a token, so the caret treats the pill as one character', () => {
    const { editor } = mountEditor();
    let token = false;
    editor.update(
      () => {
        token = $createMentionNode('ana', 'agent', '#7c5cff').isToken();
      },
      { discrete: true }
    );
    expect(token).toBe(true);
  });

  it('survives exportJSON → importJSON unchanged', () => {
    const { editor } = mountEditor();
    let serialized: ReturnType<MentionNode['exportJSON']> | null = null;
    let rebuiltText = '';
    let rebuiltIsMention = false;

    editor.update(
      () => {
        const node = $createMentionNode('ana', 'agent', '#7c5cff');
        $getRoot().clear().append($createParagraphNode().append(node));
        serialized = node.exportJSON();
        const rebuilt = MentionNode.importJSON(serialized);
        rebuiltText = rebuilt.getTextContent();
        rebuiltIsMention = $isMentionNode(rebuilt);
      },
      { discrete: true }
    );

    expect(serialized).toMatchObject({ handle: 'ana', kind: 'agent', identityColor: '#7c5cff' });
    expect(rebuiltText).toBe('@ana');
    expect(rebuiltIsMention).toBe(true);
  });
});

describe('COMPOSER_NODES', () => {
  // The heading and list transformers silently do nothing when their node
  // classes are unregistered — a `# ` that never becomes a heading, and no
  // error to say why.
  it('registers every class the transformers depend on, and nothing more', () => {
    expect(COMPOSER_NODES.map((node) => node.getType()).sort()).toEqual([
      'composer-mention',
      'heading',
      'list',
      'listitem',
    ]);
  });
});
