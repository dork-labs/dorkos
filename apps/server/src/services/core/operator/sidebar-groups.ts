/**
 * Membership edits to ONE sidebar section, without rewriting the rest of them
 * (DOR-2055).
 *
 * ## Why this exists rather than another `config_patch`
 *
 * `ui.sidebar.groups` is an array, and every general-purpose config write
 * REPLACES an array wholesale (`deepMerge` in `config-patch.ts`). So the only
 * way to add one agent to one section through the settings door is to send the
 * whole list back — every section, every member, in order. On 2026-09-15 DorkBot
 * was asked to file three agents under "DorkOS" and did exactly that. It worked,
 * and it was luck: a drag the person made between the read and the write would
 * have been overwritten with no error anywhere, and one mistyped section in that
 * payload would have deleted every other section the person had.
 *
 * The functions here take the opposite shape. They read the stored sections,
 * change the ONE the caller named, and hand back a `SidebarPrefs` in which every
 * other section is the object that came out of the store — not a copy, the same
 * reference — so "we left the others alone" is a fact about the data rather than
 * a promise in prose.
 *
 * ## The write contract is still the WHOLE section
 *
 * Narrow reads, whole-section write. `ui.sidebar` is persisted as one value and
 * the client's own writes send the complete section every time (the header of
 * `entities/config/model/use-sidebar-prefs.ts`), so a server-side writer that
 * sent a fragment would be inventing a second contract for the same key. What
 * this module narrows is the READ-MODIFY step, which is where the loss actually
 * happened.
 *
 * ## Vocabulary
 *
 * A person reads "sidebar section"; the schema, the config path and every
 * identifier here say `group`. That split is the repo rule (AGENTS.md), and the
 * two meet in the refusal strings, which are model-facing prose and therefore
 * say section.
 *
 * @module services/core/operator/sidebar-groups
 */
import { randomUUID } from 'node:crypto';
import {
  sameSidebarItem,
  SIDEBAR_PREFS_DEFAULTS,
  type SidebarGroup,
  type SidebarItemRef,
  type SidebarPrefs,
  type UserConfig,
} from '@dorkos/shared/config-schema';

/**
 * The stored sidebar prefs, or the canonical empty ones.
 *
 * `UserConfigSchema` defaults both `ui` and `ui.sidebar`, so a config that has
 * been through it always carries them and this fallback never fires in a running
 * server. It is here for the two places that are not one: a store nobody has
 * loaded yet, and a test double standing in for one. The fallback is
 * {@link SIDEBAR_PREFS_DEFAULTS}, the same object the client falls back to while
 * config loads, so "no sections stored" reads the same on both sides of the
 * wire instead of throwing on a missing key.
 *
 * @param ui - The stored `ui` section, however incomplete.
 * @returns The sidebar prefs to read and edit.
 */
export function storedSidebarPrefs(ui: UserConfig['ui'] | undefined): SidebarPrefs {
  return ui?.sidebar ?? SIDEBAR_PREFS_DEFAULTS;
}

/** The section a caller named could not be resolved to exactly one editable section. */
export interface SidebarGroupRefusal {
  /** Machine-readable reason, stable across both sidebar capabilities. */
  code: 'SIDEBAR_GROUP_NOT_FOUND' | 'SIDEBAR_GROUP_AMBIGUOUS' | 'SIDEBAR_GROUP_IS_SMART';
  /** One paragraph written for the model: what went wrong and what to do next. */
  error: string;
  /** Every section this person has, by name, so the model can pick one. */
  sections: string[];
}

/** Either the one section the caller meant, or the reason there is no such thing. */
export type SidebarGroupLookup =
  { ok: true; group: SidebarGroup } | ({ ok: false } & SidebarGroupRefusal);

/** Every section's display name, in stored order, for a refusal a model can act on. */
function sectionNames(groups: readonly SidebarGroup[]): string[] {
  return groups.map((group) => group.name);
}

/** The sentence that lists what the person actually has, or says they have none. */
function describeSections(groups: readonly SidebarGroup[]): string {
  if (groups.length === 0) return 'This person has no sidebar sections yet.';
  return `The sidebar sections that exist are ${groups.map((g) => `"${g.name}"`).join(', ')}.`;
}

/**
 * Find the one section a caller named, by id first and then by name.
 *
 * ## Why id first, and why name at all
 *
 * A section's id is a UUID minted in the browser; nobody says it out loud. A
 * person asks for "DorkOS", so a capability that only took ids would push every
 * caller into a listing round trip to translate a name it was already given.
 * Matching the id FIRST keeps the unambiguous handle authoritative: an id is
 * exact, so it can never be beaten by a section whose NAME happens to be that
 * same string.
 *
 * Name matching ignores case and surrounding space, because "dorkos" is what a
 * person types and `SidebarGroupSchema` trims the stored name anyway.
 *
 * ## Why a duplicate name is refused instead of resolved
 *
 * The schema allows two sections to share a name (ids disambiguate). Picking the
 * first of two is exactly the silent-wrong-target failure this whole capability
 * exists to remove, so an ambiguous name is refused and the refusal hands back
 * the ids to choose between.
 *
 * ## Why a smart section is refused
 *
 * A smart section derives its members from `rules`; its `items` array is kept
 * only so "convert to manual" has somewhere to land, and the sidebar never reads
 * it (`build-library-sections.ts` skips smart sections when it indexes
 * membership). Writing into it would report success and change nothing anyone
 * can see, which is the worst answer available.
 *
 * @param groups - The stored sections, in order.
 * @param selector - The id or name the caller sent.
 * @returns The matched section, or the refusal to answer with.
 */
export function resolveSidebarGroup(
  groups: readonly SidebarGroup[],
  selector: string
): SidebarGroupLookup {
  const wanted = selector.trim();
  const byId = groups.find((group) => group.id === wanted);
  const matches = byId
    ? [byId]
    : groups.filter((group) => group.name.toLowerCase() === wanted.toLowerCase());

  if (matches.length === 0) {
    return {
      ok: false,
      code: 'SIDEBAR_GROUP_NOT_FOUND',
      error:
        `There is no sidebar section called "${selector}". ${describeSections(groups)} ` +
        'Send one of those, or set createIfMissing to true to make a new section with the ' +
        'name you sent.',
      sections: sectionNames(groups),
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      code: 'SIDEBAR_GROUP_AMBIGUOUS',
      error:
        `More than one sidebar section is called "${selector}", so it is not clear which one ` +
        `you mean. Send the id of the one you want: ${matches.map((g) => `"${g.id}"`).join(', ')}.`,
      sections: sectionNames(groups),
    };
  }

  const group = matches[0]!;
  if (group.kind === 'smart') {
    return {
      ok: false,
      code: 'SIDEBAR_GROUP_IS_SMART',
      error:
        `"${group.name}" is a smart section: what it shows comes from its rules, not from a ` +
        'list somebody filed. Adding or removing members there would change nothing on screen. ' +
        'Ask the person to change its rules, or to convert it to a hand-sorted section first.',
      sections: sectionNames(groups),
    };
  }
  return { ok: true, group };
}

/** What an append did: the new member list, and which refs fell on each side of it. */
export interface SidebarItemsAdded {
  /** The section's member list after the append. */
  items: SidebarItemRef[];
  /** The refs that were not there and now are, in the order they were sent. */
  added: SidebarItemRef[];
  /** The refs that were already members, so nothing happened to them. */
  alreadyPresent: SidebarItemRef[];
}

/**
 * Append the members that are not already there, and say which were which.
 *
 * Deduplicates against the section AND against the rest of the same request, so
 * a caller that sends one agent twice adds it once. `sameSidebarItem` is the
 * only correct comparison: a ref is a discriminated union of plain objects, so
 * `includes` compares by reference and would always miss.
 *
 * The already-present refs are reported rather than silently dropped because the
 * caller is a model about to tell a person what it did, and "three added" when
 * one was already filed is a small lie it has no way to notice.
 *
 * @param existing - The section's current member list.
 * @param incoming - The refs the caller wants filed there.
 * @returns The next member list and the two groups it was built from.
 */
export function addSidebarItems(
  existing: readonly SidebarItemRef[],
  incoming: readonly SidebarItemRef[]
): SidebarItemsAdded {
  const items = [...existing];
  const added: SidebarItemRef[] = [];
  const alreadyPresent: SidebarItemRef[] = [];

  for (const ref of incoming) {
    if (items.some((member) => sameSidebarItem(member, ref))) {
      alreadyPresent.push(ref);
      continue;
    }
    items.push(ref);
    added.push(ref);
  }
  return { items, added, alreadyPresent };
}

/** What a removal did: the new member list, and which refs fell on each side of it. */
export interface SidebarItemsRemoved {
  /** The section's member list after the removal. */
  items: SidebarItemRef[];
  /** The refs that were members and are not any more. */
  removed: SidebarItemRef[];
  /** The refs that were never in this section, so nothing happened to them. */
  notPresent: SidebarItemRef[];
}

/**
 * Drop the named members from a section, leaving the section itself in place.
 *
 * **Removing the last member leaves an empty section rather than deleting it.**
 * An empty section is a thing the person made and can still drag into; deleting
 * it would be a second, unasked-for change riding on the back of the first, and
 * this capability's whole contract is that it touches exactly what it was
 * pointed at.
 *
 * @param existing - The section's current member list.
 * @param outgoing - The refs the caller wants out of it.
 * @returns The next member list and the two groups it was built from.
 */
export function removeSidebarItems(
  existing: readonly SidebarItemRef[],
  outgoing: readonly SidebarItemRef[]
): SidebarItemsRemoved {
  const removed: SidebarItemRef[] = [];
  const notPresent: SidebarItemRef[] = [];

  for (const ref of outgoing) {
    if (existing.some((member) => sameSidebarItem(member, ref))) removed.push(ref);
    else notPresent.push(ref);
  }
  const items = existing.filter((member) => !removed.some((ref) => sameSidebarItem(member, ref)));
  return { items, removed, notPresent };
}

/**
 * Mint an empty hand-sorted section, exactly as the app's own "New section" does.
 *
 * Every value here mirrors `createGroup` in
 * `apps/client/src/layers/entities/config/model/use-sidebar-prefs.ts`, which is
 * the only other place a section is created. They are written out rather than
 * left to the schema's defaults on purpose: a section made by an agent and a
 * section made by a person must be indistinguishable on disk, and a default that
 * moved in the schema would otherwise split the two silently.
 *
 * @param name - The display name the caller asked for.
 * @returns A new, empty, expanded, manually-sorted section.
 */
export function newSidebarGroup(name: string): SidebarGroup {
  return {
    id: randomUUID(),
    name,
    items: [],
    sortMode: 'manual',
    collapsed: false,
    displayFilter: 'all',
    muted: false,
    kind: 'manual',
  };
}

/**
 * Put one section back into the prefs, by id, leaving every other section as the
 * exact object that came out of the store.
 *
 * The identity is the point, not an optimization: it is what lets a test assert
 * that a write touched one section by comparing references, and what makes the
 * eventual JSON byte-identical for everything the caller did not name.
 *
 * @param prefs - The stored sidebar prefs.
 * @param group - The edited section; its `id` decides where it lands.
 * @returns The next prefs, or `prefs` itself when the id is not there.
 */
export function replaceSidebarGroup(prefs: SidebarPrefs, group: SidebarGroup): SidebarPrefs {
  if (!prefs.groups.some((existing) => existing.id === group.id)) return prefs;
  return { ...prefs, groups: prefs.groups.map((g) => (g.id === group.id ? group : g)) };
}

/**
 * Add a brand-new section after the ones the person already has.
 *
 * Appended rather than prepended because the sidebar renders sections in stored
 * order, and a new one arriving at the top would rearrange a list the person
 * arranged.
 *
 * @param prefs - The stored sidebar prefs.
 * @param group - The section to append.
 * @returns The next prefs.
 */
export function appendSidebarGroup(prefs: SidebarPrefs, group: SidebarGroup): SidebarPrefs {
  return { ...prefs, groups: [...prefs.groups, group] };
}

/**
 * The names of the OTHER hand-sorted sections that already hold one of these refs.
 *
 * Membership is single-parent everywhere the app writes it — the client's own
 * `moveToGroup` lifts a ref out of every section before filing it — but this
 * capability is specified to leave every other section byte-identical, so it
 * cannot quietly evict anything. The honest resolution is to file the item where
 * it was asked to and SAY that the person will now see it twice, which is a
 * sentence a model can pass on and a person can act on.
 *
 * @param groups - The stored sections, in order.
 * @param exceptGroupId - The section being written, which is never reported.
 * @param refs - The refs just filed.
 * @returns One note per other section holding one of them, empty when there are none.
 */
export function describeDuplicateMemberships(
  groups: readonly SidebarGroup[],
  exceptGroupId: string,
  refs: readonly SidebarItemRef[]
): string[] {
  const notes: string[] = [];
  for (const group of groups) {
    if (group.id === exceptGroupId || group.kind === 'smart') continue;
    const shared = refs.filter((ref) => group.items.some((member) => sameSidebarItem(member, ref)));
    if (shared.length === 0) continue;
    notes.push(
      `${shared.length === 1 ? 'One of these is' : `${shared.length} of these are`} also in the ` +
        `sidebar section "${group.name}", so the person will see ${
          shared.length === 1 ? 'it' : 'them'
        } in both places.`
    );
  }
  return notes;
}
