/**
 * The one way a palette row says "findable, but not live" (P3 AC-5).
 *
 * @module features/command-palette/ui/ArchivedMark
 */
/**
 * A small, plain word on a row that is no longer current.
 *
 * **One component because a channel and a conversation must say it the same
 * way.** They get there differently — somebody closed the channel, while the
 * conversation simply stopped being today's business at the cockpit's 4am
 * boundary — but what the reader needs is identical in both cases: this row is
 * still real, still openable, and is not part of what is happening now. Two
 * separate labels would invite two different words, and a person skimming a
 * search result would have to learn which is which.
 *
 * **Plain text rather than a badge with a hidden label**, because it is part of
 * what the row is CALLED: a screen reader hears "Shipping 2025 Archived" as one
 * name, which is exactly what a sighted reader sees. The palette is the only
 * surface that lists an archived channel at all (DOR-1051), so nothing else on
 * screen would explain why a closed thing is in front of you.
 *
 * It is deliberately not a colour signal. Amber and red in this cockpit mean
 * "something is waiting on you"; archived is the opposite claim, so it borrows
 * the border and the quiet foreground every other piece of row metadata uses.
 */
export function ArchivedMark() {
  return (
    <span
      // A test id rather than a `data-slot`, matching `PaletteScopeChip`: a
      // browser test has to be able to say "this row carries the mark" without
      // matching the word "Archived" wherever else it might appear on screen.
      data-testid="palette-archived-mark"
      className="text-muted-foreground border-border shrink-0 rounded-full border px-1.5 py-0.5 text-3xs font-medium"
    >
      Archived
    </span>
  );
}
