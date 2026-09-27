import { useRef, useState, type RefObject } from 'react';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { toast } from 'sonner';
import type { CommunityConnectionDescriptor } from '@dorkos/shared/community-connections';
import { CommunityInstallationDestinationSchema } from '@dorkos/shared/config-schema';
import { getCommunityRouteEpoch, useIsMobile, useTransport } from '@/layers/shared/model';
import { getCommunityAuthority, isCommunityAuthorityCurrent } from '@/layers/shared/lib';
import { focusPageHeading } from '@/layers/shared/ui';

/**
 * Notice whether the person presses or types anywhere until stopped.
 *
 * A phone switch to a remote Community can take seconds. Focus moving in that
 * time is not enough to say the person moved it — a composer takes focus on
 * mount by itself — so what counts is their own hand on a key or the screen.
 *
 * **Any key counts, on purpose** — Shift, Tab and arrows included, not only
 * keys that type. A person pressing Tab is steering focus themselves, and one
 * holding Shift is mid-way to doing something; either way the switcher yanking
 * focus to the heading would fight them. Missing a heading announcement is the
 * cheaper mistake.
 */
function watchPersonInput(): { acted: () => boolean; stop: () => void } {
  let acted = false;
  const mark = () => {
    acted = true;
  };
  document.addEventListener('pointerdown', mark, true);
  document.addEventListener('keydown', mark, true);
  return {
    acted: () => acted,
    stop: () => {
      document.removeEventListener('pointerdown', mark, true);
      document.removeEventListener('keydown', mark, true);
    },
  };
}

/** What {@link useContextSelection} needs from the switcher. */
export interface ContextSelectionOptions {
  /** The switcher's trigger, where focus goes back when a phone switch fails. */
  trigger: RefObject<HTMLButtonElement | null>;
  /** The Community the route shows now, or `undefined` for this installation. */
  selectedRef: string | undefined;
}

/**
 * Move the route to this installation or to one connected Community.
 *
 * The route stays on the old context until the target destination has been
 * reauthorized, and only one switch runs at a time. On a phone, where focus
 * goes after a switch is decided here, so `holdCloseFocus` tells the menu not
 * to hand focus back to its trigger as it closes.
 *
 * @param options - The trigger and the current selection.
 */
export function useContextSelection({ trigger, selectedRef }: ContextSelectionOptions) {
  const transport = useTransport();
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const location = useRouterState({ select: (state) => state.location }) as {
    pathname: string;
    search: { community?: string; id?: string; thread?: string };
  };
  const pendingSelection = useRef(false);
  /**
   * A phone choice is in flight, so the sheet must not hand focus back to the
   * trigger as it closes: where focus goes is decided when the switch settles
   * ({@link settlePhoneFocus}), and the sheet can close before or after that.
   */
  const holdCloseFocus = useRef(false);
  const [pendingRef, setPendingRef] = useState<string | null>(null);

  /**
   * Put focus where a finished phone choice leaves the person.
   *
   * "Selecting closes the sheet, commits navigation, and moves focus to the
   * new page heading" (spec, Phone and narrow widths). Only a switch that
   * landed moves it there. One that failed or was overtaken lets go of the
   * close hold instead, and if focus has already dropped to the page body
   * with nowhere to be, it goes back to the trigger — what the sheet would
   * have done — but never away from anything the person has since focused.
   * Desktop keeps the popover's own focus return, so this is phone-only.
   *
   * A remote Community can take seconds to answer. If the person has
   * pressed or typed somewhere in that time — the message box, a link — their
   * focus stays where they put it. Focus the app moved by itself (a composer
   * taking it on mount) is not theirs, and the heading still wins over it.
   */
  function settlePhoneFocus(landed: boolean, personActed: boolean) {
    if (!isMobile) return;
    if (!landed) holdCloseFocus.current = false;
    if (personActed) return;
    if (landed) {
      // The heading may still be waiting for its full name; the person can act
      // during that wait too, and wins if they do.
      const late = watchPersonInput();
      void focusPageHeading({ cancelled: late.acted }).finally(late.stop);
      return;
    }
    const active = document.activeElement;
    if (active === null || active === document.body) trigger.current?.focus();
  }

  async function selectCommunity(connection: CommunityConnectionDescriptor) {
    if (connection.ref === selectedRef || pendingSelection.current) return;
    // Only a connected Community can be entered; the switcher sends any other
    // to the connect dialog before it gets here.
    if (connection.status !== 'connected') return;
    const owner = getCommunityAuthority();
    if (owner.ownerKey === null) return;
    const capturedOwner = { epoch: owner.epoch, ownerKey: owner.ownerKey };
    const previousLocation = { pathname: location.pathname, search: location.search };
    // Set before the first await, so it is in place by the time the sheet,
    // closing on this same press, asks where focus should go.
    holdCloseFocus.current = isMobile;
    const person = watchPersonInput();
    pendingSelection.current = true;
    setPendingRef(connection.ref);
    let targetCommitted = false;
    let capturedRoute: ReturnType<typeof getCommunityRouteEpoch> | null = null;
    try {
      await navigate({ to: '/channels', search: { community: connection.ref } });
      targetCommitted = true;
      capturedRoute = getCommunityRouteEpoch();
      const remembered = await transport.resolveCommunityNavigation(connection.ref);
      const fallback = remembered
        ? null
        : ((await transport.listRemoteCommunityRooms(connection.ref)).rooms.find(
            (room) => room.readable && !room.archived
          ) ?? null);
      const roomId = remembered?.roomId ?? fallback?.roomId;
      if (!isCommunityAuthorityCurrent(capturedOwner) || !capturedRoute.isCurrent()) {
        settlePhoneFocus(false, person.acted());
        return;
      }
      if (roomId)
        await navigate({
          to: '/channels',
          search: {
            community: connection.ref,
            ...(roomId ? { id: roomId } : {}),
            ...(remembered?.threadId ? { thread: remembered.threadId } : {}),
          },
        });
      settlePhoneFocus(true, person.acted());
    } catch {
      settlePhoneFocus(false, person.acted());
      // A target may render its labelled skeleton before its remote destination
      // resolves, but a failed read cannot leave it selected. Restore only while
      // this exact route and owner remain current; a newer choice always wins.
      const restore =
        targetCommitted &&
        capturedRoute?.isCurrent() === true &&
        isCommunityAuthorityCurrent(capturedOwner);
      if (restore) {
        const restored = await navigate({
          to: previousLocation.pathname,
          search: previousLocation.search,
          replace: true,
        } as never).then(
          () => true,
          () => false
        );
        // Say so (spec: "announce the failure"): the label snapping back is
        // easy to miss, and a screen reader hears nothing at all. Only once
        // the way back has actually landed, because the message promises it;
        // silent when the person has already chosen somewhere else.
        if (restored)
          toast.error(`Couldn’t open ${connection.label}.`, {
            description: 'You’re still where you were. Try again in a moment.',
          });
      }
    } finally {
      person.stop();
      pendingSelection.current = false;
      setPendingRef(null);
    }
  }

  async function selectInstallation() {
    if (selectedRef === undefined || pendingSelection.current) return;
    const owner = getCommunityAuthority();
    if (owner.ownerKey === null) return;
    const capturedOwner = { epoch: owner.epoch, ownerKey: owner.ownerKey };
    const capturedRoute = getCommunityRouteEpoch();
    holdCloseFocus.current = isMobile;
    const person = watchPersonInput();
    pendingSelection.current = true;
    try {
      const state = await transport.getCommunityNavigation();
      if (
        state.ownerKey !== capturedOwner.ownerKey ||
        !isCommunityAuthorityCurrent(capturedOwner) ||
        !capturedRoute.isCurrent()
      ) {
        settlePhoneFocus(false, person.acted());
        return;
      }
      const destination = CommunityInstallationDestinationSchema.safeParse(
        state.installationDestination
      );
      await navigate(
        destination.success
          ? ({ to: destination.data.path, search: destination.data.search } as never)
          : { to: '/' }
      );
      settlePhoneFocus(true, person.acted());
    } catch {
      const fallback = isCommunityAuthorityCurrent(capturedOwner) && capturedRoute.isCurrent();
      if (fallback) await navigate({ to: '/' });
      settlePhoneFocus(fallback, person.acted());
    } finally {
      person.stop();
      pendingSelection.current = false;
    }
  }

  return {
    /** The Community a switch is on its way to, or `null`. */
    pendingRef,
    /** Whether a switch is in flight, so another must wait. */
    isSelecting: () => pendingSelection.current,
    /** Keep the closing menu from handing focus back to its trigger, once. */
    holdCloseFocus: () => {
      holdCloseFocus.current = true;
    },
    /** Spend a hold, if one was set: `true` means the menu must not move focus. */
    takeCloseFocusHold: () => {
      const held = holdCloseFocus.current;
      holdCloseFocus.current = false;
      return held;
    },
    selectCommunity,
    selectInstallation,
  };
}
