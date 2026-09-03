import { useEffect, useMemo } from 'react';
import { motion } from 'motion/react';
import { MENTION_LISTBOX_ID, mentionRowId } from '../model/use-mention-autocomplete';
import { SECTION_LABELS, type MentionRow, type MentionSection } from '../lib/mention-rows';

interface MentionPaletteProps {
  /** The rows to draw, flat and already in section order. */
  rows: MentionRow[];
  /** Index into `rows` — the same integer the keyboard and Enter both use. */
  selectedIndex: number;
  onSelect: (row: MentionRow) => void;
}

/** One section's heading plus the rows under it, carrying their flat indices. */
interface RenderedSection {
  section: MentionSection;
  items: { row: MentionRow; index: number }[];
}

/**
 * The `@` picker: People and Agents under one sigil, one highlight moving
 * through both.
 *
 * Headings are re-derived from the flat row list rather than being fed in as
 * separate lists, so a row's index here is exactly its index in the array the
 * cursor moves through. That is what stops the announced row and the inserted
 * row from drifting apart — there is no second numbering for them to disagree
 * about.
 */
export function MentionPalette({ rows, selectedIndex, onSelect }: MentionPaletteProps) {
  // Group by section while preserving each row's FLAT index. Built by walking
  // the list in order, so a section break never renumbers anything after it.
  const sections = useMemo(() => {
    const grouped: RenderedSection[] = [];
    rows.forEach((row, index) => {
      const last = grouped[grouped.length - 1];
      if (last && last.section === row.section) last.items.push({ row, index });
      else grouped.push({ section: row.section, items: [{ row, index }] });
    });
    return grouped;
  }, [rows]);

  useEffect(() => {
    document.getElementById(mentionRowId(selectedIndex))?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98, y: 4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98, y: 4 }}
      transition={{ duration: 0.15, ease: [0, 0, 0.2, 1] }}
      className="bg-popover max-h-80 overflow-hidden rounded-lg border shadow-lg"
      // Keeps the composer focused through a click on a row. Without it the
      // textarea blurs first, which dismisses the panel — so the click lands on
      // nothing and the mention is never inserted. Invisible to jsdom, which
      // runs no focus/blur race at all.
      onMouseDown={(e) => e.preventDefault()}
    >
      <div
        id={MENTION_LISTBOX_ID}
        role="listbox"
        aria-label="Mentions"
        className="max-h-72 overflow-y-auto p-1.5"
      >
        {rows.length === 0 ? (
          <div className="text-muted-foreground px-2 py-4 text-center text-sm">
            No one by that name.
          </div>
        ) : (
          sections.map(({ section, items }, sectionIdx) => (
            <div key={section} role="group" aria-label={SECTION_LABELS[section]}>
              {sectionIdx > 0 && <div className="bg-border mx-2 my-1.5 h-px" />}
              {/* The group already carries this name for assistive tech, so the
                  visible heading is decoration — announcing it again is the
                  duplicate-name defect this repo has shipped before. */}
              <div
                aria-hidden
                className="text-muted-foreground/70 text-2xs px-2 pt-1.5 pb-1 font-medium tracking-wide uppercase"
              >
                {SECTION_LABELS[section]}
              </div>
              {items.map(({ row, index }) => {
                const isSelected = index === selectedIndex;
                return (
                  // No `tabIndex`, and no key handler. This is the
                  // `aria-activedescendant` pattern: DOM focus never leaves the
                  // composer — the panel swallows mousedown, and the composer
                  // intercepts Tab while rows are showing — so a row can never
                  // receive a keystroke. Both rules below assume an element the
                  // keyboard reaches directly; satisfying them here would mean
                  // shipping a focus stop and a key handler that nothing can
                  // ever reach, which reads as a keyboard affordance and is not
                  // one. The keyboard reaches these rows through the composer,
                  // which owns the selection and publishes it as
                  // `aria-activedescendant`.
                  // eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/interactive-supports-focus -- option is never focusable by design; see above
                  <div
                    key={row.authorId}
                    id={mentionRowId(index)}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={row.disabled}
                    data-selected={isSelected}
                    data-disabled={row.disabled}
                    onClick={() => {
                      if (!row.disabled) onSelect(row);
                    }}
                    className={
                      row.disabled
                        ? 'flex cursor-not-allowed items-center gap-2 rounded-md px-2 py-1.5 opacity-45'
                        : 'data-[selected=true]:bg-accent hover:bg-muted flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 transition-colors duration-100'
                    }
                  >
                    {/* Decoration: the row is already named by its text, and an
                        emoji read aloud before every name is noise. */}
                    <span aria-hidden className="size-4 shrink-0 text-center text-sm leading-none">
                      {row.emoji}
                    </span>
                    <span className="text-foreground truncate text-sm font-medium">
                      {row.label}
                    </span>
                    {row.handle !== undefined && (
                      <span className="text-muted-foreground/70 truncate font-mono text-xs">
                        @{row.handle}
                      </span>
                    )}
                    {row.disabledReason !== undefined && (
                      <span className="text-muted-foreground/70 text-2xs ml-auto shrink-0">
                        {row.disabledReason}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </motion.div>
  );
}
