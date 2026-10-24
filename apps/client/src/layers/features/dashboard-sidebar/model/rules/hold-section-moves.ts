/**
 * Never move a row out from under the person using the panel.
 *
 * An agent moves between sections on its own: a smart section such as "Active
 * now" picks it up when it starts working and lets it go when it stops, and it
 * lands in Direct messages instead (DOR-3092). A row that jumped while the
 * pointer was over it, or while focus was on it, would turn the next click into
 * a click on something else. So while the person is in the panel the section
 * each row sits in is held where it was, and the moves land when they leave.
 * Everything ELSE about a row — bold, its count, its live dot — still updates
 * in place, because the row object drawn is always this frame's.
 *
 * Pure: the snapshot is taken by the hook that knows about the pointer
 * (`use-held-sections.ts`); this decides only what a held panel looks like.
 *
 * @module features/dashboard-sidebar/model/rules/hold-section-moves
 */
import type { SidebarRowModel, SidebarSectionModel } from '../build-sidebar-model';

/** Where one row sat when the hold began. */
interface HeldPlace {
  /** The section it was in. */
  sectionId: SidebarSectionModel['id'];
  /** Its position in that section. */
  index: number;
  /** The row as it was, drawn again if this frame has dropped it. */
  row: SidebarRowModel;
}

/** Every row's place when the hold began, by row key. */
export type SectionMembership = ReadonlyMap<string, HeldPlace>;

/**
 * Write down where every row is.
 *
 * @param sections - The panel's sections, as drawn.
 */
export function membershipOf(sections: readonly SidebarSectionModel[]): SectionMembership {
  const places = new Map<string, HeldPlace>();
  for (const section of sections) {
    section.rows.forEach((row, index) => {
      places.set(row.key, { sectionId: section.id, index, row });
    });
  }
  return places;
}

/**
 * The live sections, with every row that changed section put back where it was.
 *
 * - A row this frame draws in a different section is drawn in its held section
 *   instead, at its held position, wearing this frame's data.
 * - A row this frame dropped altogether (an agent that left a smart section and
 *   has no direct message) is drawn where it was, as it was.
 * - A row that is new this frame is drawn where it arrived: an arrival moves
 *   nothing that is already there.
 * - A held section that no longer exists lets its rows go.
 * - A door is never held: "Message an agent" becoming "Message an agent or
 *   person" is a different row, not a move.
 *
 * Returns `live` itself when nothing moved, so a held panel that is not holding
 * anything costs no new objects.
 *
 * @param live - This frame's sections.
 * @param held - Where every row was when the hold began.
 */
export function holdSectionMoves(
  live: readonly SidebarSectionModel[],
  held: SectionMembership
): readonly SidebarSectionModel[] {
  const liveIds = new Set(live.map((section) => section.id));
  const liveRows = new Map<string, SidebarRowModel>();
  const liveSectionOf = new Map<string, SidebarSectionModel['id']>();
  for (const section of live) {
    for (const row of section.rows) {
      liveRows.set(row.key, row);
      liveSectionOf.set(row.key, section.id);
    }
  }

  // The rows to put back, by the section they are going back into.
  const returning = new Map<SidebarSectionModel['id'], { index: number; row: SidebarRowModel }[]>();
  for (const [key, place] of held) {
    if (place.row.target.kind === 'command') continue;
    if (liveSectionOf.get(key) === place.sectionId || !liveIds.has(place.sectionId)) continue;
    const list = returning.get(place.sectionId) ?? [];
    list.push({ index: place.index, row: liveRows.get(key) ?? place.row });
    returning.set(place.sectionId, list);
  }
  const leaving = new Set([...returning.values()].flat().map((entry) => entry.row.key));
  if (leaving.size === 0) return live;

  return live.map((section) => {
    const back = returning.get(section.id) ?? [];
    const stays = section.rows.filter((row) => !leaving.has(row.key));
    if (back.length === 0 && stays.length === section.rows.length) return section;
    const rows = [...stays];
    for (const entry of [...back].sort((a, b) => a.index - b.index)) {
      rows.splice(Math.min(entry.index, rows.length), 0, entry.row);
    }
    return { ...section, rows };
  });
}
