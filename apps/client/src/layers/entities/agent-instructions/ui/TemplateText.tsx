/**
 * A block's text with its `{{variables}}` drawn as chips.
 *
 * A chip says "this part is filled in per agent or per turn" without a person
 * having to parse braces. Only documented variables become chips; anything
 * else in braces is the block's own text and is shown as written.
 *
 * @module entities/agent-instructions/ui/TemplateText
 */
import { Fragment, useMemo } from 'react';

const TOKEN = /\{\{([a-z_]+\.[a-z_]+)\}\}/g;

/** Props for {@link TemplateText}. */
export interface TemplateTextProps {
  /** The block's text. */
  text: string;
  /** Labels for the documented variables, by id. */
  labels: ReadonlyMap<string, string>;
}

/**
 * Split text into plain runs and variable chips.
 *
 * @param text - The block's text.
 * @param labels - The documented variables.
 */
export function templateParts(
  text: string,
  labels: ReadonlyMap<string, string>
): ({ kind: 'text'; value: string } | { kind: 'variable'; id: string })[] {
  const parts: ({ kind: 'text'; value: string } | { kind: 'variable'; id: string })[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    if (!labels.has(match[1]!)) continue;
    if (match.index > last) parts.push({ kind: 'text', value: text.slice(last, match.index) });
    parts.push({ kind: 'variable', id: match[1]! });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', value: text.slice(last) });
  return parts;
}

/**
 * The text, chips inline.
 *
 * @param props - See {@link TemplateTextProps}.
 */
export function TemplateText({ text, labels }: TemplateTextProps) {
  const parts = useMemo(() => templateParts(text, labels), [text, labels]);
  return (
    <>
      {parts.map((part, index) =>
        part.kind === 'text' ? (
          <Fragment key={index}>{part.value}</Fragment>
        ) : (
          <span
            key={index}
            data-slot="instructions-variable"
            title={labels.get(part.id)}
            className="bg-status-info/15 text-foreground rounded px-1 py-px font-medium whitespace-nowrap"
          >
            {part.id}
          </span>
        )
      )}
    </>
  );
}
