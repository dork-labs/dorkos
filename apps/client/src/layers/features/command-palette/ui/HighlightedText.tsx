interface HighlightedTextProps {
  /** The full text string to render */
  text: string;
  /** Fuse.js match indices -- array of [start, end] pairs where end is inclusive */
  indices?: readonly [number, number][];
  className?: string;
}

/**
 * Render text with matched character ranges bolded.
 *
 * Builds React nodes from Fuse.js match index pairs.
 * Safe by construction -- all content goes through React's createElement pipeline.
 *
 * @param text - Full text to render
 * @param indices - Fuse.js match ranges where each pair is [start, endInclusive]
 * @param className - Optional CSS class for the wrapper span
 */
export function HighlightedText({ text, indices, className }: HighlightedTextProps) {
  if (!indices || indices.length === 0) {
    return <span className={className}>{text}</span>;
  }

  const parts: React.ReactNode[] = [];
  let lastIdx = 0;

  for (let i = 0; i < indices.length; i++) {
    const [start, end] = indices[i];
    // end is inclusive in Fuse.js
    const matchEnd = end + 1;

    if (lastIdx < start) {
      parts.push(<span key={`p-${i}`}>{text.slice(lastIdx, start)}</span>);
    }
    parts.push(
      <mark key={`m-${i}`} className="bg-transparent text-foreground font-semibold">
        {text.slice(start, matchEnd)}
      </mark>
    );
    lastIdx = matchEnd;
  }

  if (lastIdx < text.length) {
    parts.push(<span key="tail">{text.slice(lastIdx)}</span>);
  }

  return <span className={className}>{parts}</span>;
}
