/**
 * The sections, in the order the model put them in.
 *
 * This component is the whole renderer: it maps `model.sections` and nothing
 * else. The order is fixed by `buildSidebarModel` and never varies with
 * content, so there is no sorting here to get wrong.
 *
 * @module features/dashboard-sidebar/ui/SidebarSections
 */
import { useCallback, useRef } from 'react';
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from 'motion/react';
import { communityRefFromRouteDestination, useCommunityRouteEpoch } from '@/layers/shared/model';
import { SidebarMenu } from '@/layers/shared/ui';
import { useSpaceVisible } from '@/layers/entities/community';
import {
  setGroupCollapsed,
  setSectionCollapsed,
  useSidebarPrefs,
  useUpdateSidebarPrefs,
} from '@/layers/entities/config';
import { useBootState } from '../model/boot/use-boot-state';
import {
  persistedSectionId,
  type SidebarModel,
  type SidebarSectionModel,
} from '../model/build-sidebar-model';
import { rowKey } from '../model/rules/targets';
import { useScrollToActive } from '../model/use-scroll-to-active';
import { useHeldSections, useInside } from '../model/use-held-sections';
import { SidebarSkeleton } from './boot/SidebarSkeleton';
import { REVEAL_CONTAINER, REVEAL_SECTION, revealTransition } from './boot/sidebar-reveal';
import { CommunityChannelGroups } from './CommunityChannelGroups';
import { GroupCreateInput } from './GroupCreateInput';
import { useSidebarChrome } from './SidebarChrome';
import { SidebarSection } from './SidebarSection';

/**
 * Whether a section is one the fold-all gesture may touch.
 *
 * `collapsible` alone is not enough: the section has to have somewhere to keep
 * the fold. A hand-made section keeps it on the section itself rather than
 * under a section id, which is why it is named here rather than reached
 * through {@link persistedSectionId}.
 *
 * @param section - Any section the model emitted.
 */
function isFoldable(section: SidebarSectionModel): boolean {
  if (!section.collapsible) return false;
  return section.id.startsWith('group:') || persistedSectionId(section.id) !== null;
}

/** Props for {@link SidebarSections}. */
export interface SidebarSectionsProps {
  /** The model to draw. */
  model: SidebarModel;
}

/**
 * Every section the model emitted, in its fixed order.
 *
 * It also owns the one cross-section act there is: Alt/Option-click on any
 * header folds or unfolds them all (BC-30). That has to live above the
 * sections, because "are any of them open?" is a question no single section can
 * answer.
 *
 * @param props - The model.
 */
export function SidebarSections({ model }: SidebarSectionsProps) {
  const { update } = useUpdateSidebarPrefs();
  const prefs = useSidebarPrefs();
  // **Rows never move under the person using the panel** (DOR-3092). While the
  // pointer is over the list or focus is in it, an agent drifting between a
  // smart section and Direct messages stays where it is; the move lands when
  // they leave. Their own changes (a drag, a pin) retake the snapshot, so those
  // land at once.
  const { inside, handlers } = useInside();
  const sections = useHeldSections(model.sections, inside, prefs);
  const route = useCommunityRouteEpoch();
  // A space's channels replace the panel only while that space is reachable:
  // any with spaces on, the official one alone with them off (DOR-2740).
  const routeCommunity = communityRefFromRouteDestination(route.destination);
  const space = useSpaceVisible(routeCommunity ?? undefined);
  const selectedCommunity = space.visible ? routeCommunity : null;
  const boot = useBootState();
  const reducedMotion = useReducedMotion();
  const chrome = useSidebarChrome();

  // When the operator switches what they are looking at, the row that lights
  // comes into view (BC-36) — and on nothing else: the key moves only when what
  // is open moves.
  const container = useRef<HTMLDivElement>(null);
  const anchor = chrome.activeTarget === null ? null : rowKey(chrome.activeTarget);
  useScrollToActive(container, anchor, boot.settled);

  const foldable = model.sections.filter(isFoldable);
  const onToggleAll = useCallback(() => {
    if (foldable.length === 0) return;
    // Fold everything unless everything is already folded, in which case the
    // gesture opens them: one key press, and it always does something.
    const collapsed = foldable.some((section) => !section.collapsed);
    update((prev) => {
      let next = prev;
      for (const section of foldable) {
        // A hand-made section's fold lives on the section itself; every other
        // section's lives under its id in `ui.sidebar.sections`.
        if (section.id.startsWith('group:')) {
          next = setGroupCollapsed(next, section.id.slice('group:'.length), collapsed);
          continue;
        }
        const stored = persistedSectionId(section.id);
        if (stored !== null) next = setSectionCollapsed(next, stored, collapsed);
      }
      return next;
    });
  }, [foldable, update]);

  // Inside a space, Add-ons is the one section of this machine's still drawn,
  // so it is also the only one Alt-click may fold: folding sections nobody can
  // see from there would be a write the person never sees the effect of.
  const spaceAddOns = model.sections.find((section) => section.id === 'addons');
  const spaceAddOnsCollapsed = spaceAddOns?.collapsed ?? false;
  const onToggleSpaceAddOns = useCallback(
    () => update((prev) => setSectionCollapsed(prev, 'addons', !spaceAddOnsCollapsed)),
    [spaceAddOnsCollapsed, update]
  );

  // Every section below arrives inside one of these, so the reveal has
  // something to stagger and a warm boot has an identical DOM to a settled cold
  // one. A wrapper that only exists during the animation would remount every
  // row the moment the panel settled.
  const sectionReveal = { variants: REVEAL_SECTION, transition: revealTransition(reducedMotion) };

  if (selectedCommunity)
    return (
      <div className="flex min-h-0 flex-col" data-community-context={selectedCommunity}>
        <CommunityChannelGroups />
        {/* A space's channels replace this machine's conversations, but a mini
            app's pages are not this machine's conversations: they stay one
            press away inside a space too. */}
        {spaceAddOns !== undefined && (
          <SidebarSection section={spaceAddOns} onToggleAll={onToggleSpaceAddOns} />
        )}
      </div>
    );

  return (
    <div ref={container} className="flex flex-col gap-1" {...handlers}>
      {/* **One reveal, and only ever one** (spec D6). `mode="wait"` is what
          makes it one: the bones fade out before the panel fades in, so the
          two are never on screen together. On a warm boot there was never a
          skeleton, so `initial={false}` means the panel is simply there. */}
      <AnimatePresence mode="wait" initial={false}>
        {boot.phase === 'cold' ? (
          <motion.div
            key="skeleton"
            exit={{ opacity: 0 }}
            transition={revealTransition(reducedMotion)}
          >
            <SidebarSkeleton />
          </motion.div>
        ) : (
          <motion.div
            key="sections"
            className="flex flex-col gap-1"
            variants={REVEAL_CONTAINER}
            initial={boot.startedWarm ? false : 'hidden'}
            animate="shown"
          >
            {/* One group, so an agent row that moves between sections slides
                from its old place to its new one (its `layoutId` is its key). */}
            <LayoutGroup id="sidebar-sections">
              {sections.map((section) => (
                <motion.div key={section.id} {...sectionReveal}>
                  <SidebarSection section={section} onToggleAll={onToggleAll} />
                  {/* Under the top items, which is where a new section lands:
                      the operator's own sections lead the list (D3). */}
                  {section.id === 'top' && <SectionCreateField />}
                </motion.div>
              ))}
            </LayoutGroup>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * The inline "name your new section" field, right where the new section will
 * appear.
 *
 * **One place, always the same place** (D3): the operator's own sections render
 * directly under the top items, so that is both where the field belongs and
 * where it can be seen.
 *
 * Renders nothing at all while no create flow is running.
 */
function SectionCreateField() {
  const chrome = useSidebarChrome();
  if (chrome.groupCreation === null) return null;
  return (
    <SidebarMenu>
      <GroupCreateInput onCommit={chrome.commitNewGroup} onCancel={chrome.cancelNewGroup} />
    </SidebarMenu>
  );
}
