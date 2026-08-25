/**
 * The page's own stops, named once.
 *
 * `/new` is one long scroll with five landmarks in it, and two things have to
 * agree about them: the sections, which carry the ids, and the pill nav, which
 * scrolls to them and lights up the one you are in. Splitting that list in two
 * is how an anchor that points at nothing ships — the click does nothing and
 * no test notices. So the list lives here, both readers import it, and
 * `__tests__/home-copy.test.ts` checks every id is actually rendered.
 */

/** One landmark on the page: the element id, and what the pill calls it. */
export interface PageSection {
  id: string;
  label: string;
  /**
   * Whether the pill drops this entry on a phone.
   *
   * The pill is one row of text on a 390px screen and five labels do not fit
   * beside the overflow button. These two go first because they are the two
   * stops a visitor reaches anyway by scrolling: they sit at the bottom of the
   * page, after the part that has to be scrolled through. Nothing becomes
   * unreachable — only unlisted.
   */
  yieldsOnMobile?: boolean;
}

/** The five stops, in the order the page presents them. */
export const PAGE_SECTIONS: readonly PageSection[] = [
  { id: 'film', label: 'film' },
  { id: 'how-it-works', label: 'how it works' },
  { id: 'tutorials', label: 'tutorials' },
  { id: 'features', label: 'features', yieldsOnMobile: true },
  { id: 'questions', label: 'questions', yieldsOnMobile: true },
];

/** Just the ids, as a stable reference the scroll-spy hook can depend on. */
export const PAGE_SECTION_IDS: readonly string[] = PAGE_SECTIONS.map((section) => section.id);
