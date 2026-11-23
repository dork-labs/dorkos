import { splitHiddenCharacters } from '@dorkos/shared/marketplace-schemas';
import { cn } from '@/layers/shared/lib/utils';

/** Props for {@link HiddenCharacterText}. */
export interface HiddenCharacterTextProps {
  /** The text, verbatim, as its author wrote it. */
  text: string;
  /** Extra classes for each hidden-character chip. */
  chipClassName?: string;
}

/**
 * Text a person is about to approve, with each hidden character drawn as a
 * small chip naming its code point (`U+202E`), so the words read exactly as
 * they will run (DOR-5075).
 *
 * A chip, not a written `<U+202E>`: anyone can type that string into a prompt,
 * and it would look like a real marker. The chip sits on `bg-background` with
 * a border, so it stands apart on the file review's `bg-muted` diff, where a
 * muted fill would vanish, and on a plain surface alike. It matches what
 * `splitHiddenCharacters` matches,
 * the same as the plain-text `revealHiddenCharacters` elsewhere.
 */
function HiddenCharacterText({ text, chipClassName }: HiddenCharacterTextProps) {
  return splitHiddenCharacters(text).map((segment, i) =>
    'text' in segment ? (
      segment.text
    ) : (
      <span
        // Segments never reorder, so their position is a stable key.
        key={i}
        data-slot="hidden-character"
        role="img"
        aria-label={`hidden character ${segment.codePoint}`}
        className={cn(
          'text-muted-foreground bg-background rounded-sm border px-1 font-mono text-xs whitespace-nowrap',
          chipClassName
        )}
      >
        {segment.codePoint}
      </span>
    )
  );
}

export { HiddenCharacterText };
