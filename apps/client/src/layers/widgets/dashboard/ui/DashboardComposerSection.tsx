/**
 * Dashboard composer — the hero action at the top of the dashboard.
 *
 * The same question DorkBot's onboarding hand-off asks ("What are we building
 * today?"), followed by a live composer. Sending a message opens a real session
 * with the default agent through the `first-message` seam (ADR 260722-111316):
 * a fresh session id is registered with the typed words, then the route changes
 * to `/session`, where the message sends as the user's own turn. Mirrors the
 * onboarding dissolve's record shape.
 *
 * Focusing the box while it is still empty floats up "Jump back in" — the last
 * few threads this person was in, one keystroke from where they left off. It is
 * the second surface of one recents model (spec `team-room-home` §D2.3); the
 * sidebar section is the first.
 *
 * @module widgets/dashboard/ui/DashboardComposerSection
 */
import { useCallback, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useAgentBirthStore, type AgentBirthRecord } from '@/layers/shared/model';
import { TOUR_ANCHORS } from '@/layers/shared/config';
import { Composer } from '@/layers/features/composer';
import { JumpBackInPopover, useJumpBackInPopover } from '@/layers/features/jump-back-in';
import { useDefaultAgentSession } from '@/layers/entities/config';

/** The composer section rendered first in the dashboard body. */
export function DashboardComposerSection() {
  const navigate = useNavigate();
  const { defaultAgentDir, defaultAgentDisplayName, defaultAgentIdentity, isDefaultAgentResolved } =
    useDefaultAgentSession();
  const [value, setValue] = useState('');
  // No `yieldToPalette`: this composer has no `@` picker to yield to (see the
  // capability matrix in `features/composer`). Phase 2 moves the box into the
  // #team room, which does — and that is the argument it will pass.
  const jumpBackIn = useJumpBackInPopover({ value });

  const handleSubmit = useCallback(() => {
    const text = value.trim();
    if (!text) return;
    // Never start a session with the config-composed fallback path — the events
    // stream 403s on the unresolved tilde. Wait for the registry-resolved dir.
    if (!isDefaultAgentResolved) return;

    const sessionId = crypto.randomUUID();
    const record: Omit<AgentBirthRecord, 'fired'> = {
      kind: 'first-message',
      name: defaultAgentIdentity.name,
      displayName: defaultAgentIdentity.displayName,
      agentId: defaultAgentIdentity.agentId,
      icon: defaultAgentIdentity.icon,
      color: defaultAgentIdentity.color,
      bornAt: new Date().toISOString(),
      path: defaultAgentDir,
      runtime: defaultAgentIdentity.runtime,
      kickoffMessage: text,
    };
    useAgentBirthStore.getState().register(sessionId, record);
    setValue('');
    navigate({ to: '/session', search: { dir: defaultAgentDir, session: sessionId } });
  }, [value, isDefaultAgentResolved, defaultAgentDir, defaultAgentIdentity, navigate]);

  return (
    // Focus and pointer-down are both watched here, on the section that is
    // already in the markup rather than through a wrapper of its own: both
    // bubble, and the popover's trigger is "the person reached for the empty
    // box". Both, and not focus alone — the composer takes the caret on mount,
    // so clicking it dispatches no focus event at all and the primary gesture
    // did nothing. The handlers ignore everything that is not the composer's
    // text field, so reaching for Send or Clear never floats a panel up.
    //
    // The rule below is about elements that BEHAVE interactively without saying
    // so — one you can click but not tab to. This section takes no focus and
    // offers no action of its own; it only overhears events from a control inside it,
    // which is already a real, keyboard-reachable combobox that announces the
    // panel through `aria-expanded` and `aria-activedescendant`. Giving this
    // element a role or a tab stop to satisfy the rule would add a focus stop
    // that does nothing, which is the defect the rule exists to prevent.
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- container overhears its combobox's focus; see above
    <section
      data-testid={TOUR_ANCHORS.dashboardComposer}
      onFocus={jumpBackIn.handleFocus}
      onBlur={jumpBackIn.handleBlur}
      onPointerDown={jumpBackIn.handlePointerDown}
    >
      <h2 className="text-foreground mb-3 text-lg font-semibold tracking-tight">
        What are we building today?
      </h2>
      {/* No `onFilesDropped`: the dashboard has no upload path today, so no
          dropzone mounts. The capability matrix's "follows chat" means it
          inherits the seam when chat's reaches it, not that it wires one now.

          `m-0` overrides Root's `m-2`, which is chat's margin and wrong here:
          this page already spaces its sections (`space-y-6` on a padded
          `max-w-4xl` column), so the extra margin only pushed the card 8px
          inside the heading above it and every other card beside it. The
          override is the caller's, not a change to Root — chat is the
          reference chrome and its default stays put. */}
      <Composer.Root className="m-0">
        {/* The lane is mounted only while the panel is: a composer at rest has
            exactly the markup it had before this existed, which is the claim
            `DashboardComposerSection-dom-parity` makes and keeps. The cost is
            an exit animation — right, for a dismissal that has to get out of
            the way the instant a person starts typing. */}
        {jumpBackIn.isOpen && (
          <Composer.OverlayLane>
            <JumpBackInPopover
              rows={jumpBackIn.rows}
              selectedIndex={jumpBackIn.selectedIndex}
              agents={jumpBackIn.agents}
              displayNames={jumpBackIn.displayNames}
              visualOf={jumpBackIn.visualOf}
              onSelect={jumpBackIn.selectRow}
            />
          </Composer.OverlayLane>
        )}
        <Composer.Input
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          isStreaming={false}
          canSubmit={isDefaultAgentResolved}
          // The shipped palette seam, driving a second palette: the arrows and
          // Enter belong to the panel while it is up, Escape takes it down, and
          // the highlighted row is announced through the field that still holds
          // the caret.
          isPaletteOpen={jumpBackIn.isOpen}
          paletteHasResults={jumpBackIn.hasRows}
          onArrowUp={jumpBackIn.moveUp}
          onArrowDown={jumpBackIn.moveDown}
          onCommandSelect={jumpBackIn.selectHighlighted}
          onEscape={jumpBackIn.dismiss}
          // Enter opens the highlighted thread; Tab does not. Tab is a pick key
          // for a palette you ASKED for by typing `@` or `/` — this one arrives
          // because you put the caret in an empty box, so tabbing on from it
          // would have carried you into a session instead of to the next
          // control.
          tabPicks={false}
          activeDescendantId={jumpBackIn.activeDescendantId}
          paletteListboxId={jumpBackIn.listboxId}
          // Nothing else on this screen explains the greyed Send, and this is very
          // often the first sentence anyone types into DorkOS: they press Enter
          // and, without this line, nothing happens for no stated reason.
          canSubmitReason="Getting your agent ready…"
          placeholder={`Message ${defaultAgentDisplayName}…`}
        />
      </Composer.Root>
    </section>
  );
}
