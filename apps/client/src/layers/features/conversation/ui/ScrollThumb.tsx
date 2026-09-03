/**
 * The thin scrollbar a conversation draws over its own scroller.
 *
 * Moved out of `features/chat` with the list it belonged to: one timeline draws
 * a session and a channel, so one thumb tracks both.
 *
 * @module features/conversation/ui/ScrollThumb
 */
import { useRef, useEffect, useCallback, useState } from 'react';

const FADE_DELAY_MS = 800;
const MIN_THUMB_HEIGHT = 24;

interface ScrollThumbProps {
  scrollRef: React.RefObject<HTMLElement | null>;
}

/**
 * Lightweight custom scrollbar overlay for virtualized scroll containers.
 *
 * Renders a thin thumb positioned absolutely within the scroll container.
 * Fades in on scroll, fades out after {@link FADE_DELAY_MS}. Supports
 * click-to-jump on the track and drag on the thumb.
 */
export function ScrollThumb({ scrollRef }: ScrollThumbProps) {
  const thumbRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [visible, setVisible] = useState(false);
  const isDraggingRef = useRef(false);
  // Whether the pointer is over the track right now — a `bool`, not the thumb's
  // own `:hover`, because the thumb is a sliver of the track and the affordance
  // a person is reaching for is "the scrollbar area," the same target OS
  // scrollbars answer to.
  const isHoveringRef = useRef(false);
  const dragStartYRef = useRef(0);
  const dragStartScrollTopRef = useRef(0);

  // Arms (or re-arms) the fade-out. Split from `showThumb` so hovering can
  // hold the thumb visible without re-triggering the "just scrolled" fade-in
  // — pointer enter and pointer leave both need to restart this timer, but
  // neither should force `visible` back to `true` on its own.
  const scheduleFade = useCallback(() => {
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    fadeTimerRef.current = setTimeout(() => {
      if (!isDraggingRef.current && !isHoveringRef.current) setVisible(false);
    }, FADE_DELAY_MS);
  }, []);

  const showThumb = useCallback(() => {
    setVisible(true);
    scheduleFade();
  }, [scheduleFade]);

  // A pointer moving toward the thumb to grab it approaches the TRACK first —
  // the thumb itself may already be faded to `opacity: 0` by the time it
  // arrives, so waking on the thumb's own hover would be too late. Wiring
  // this to the track's full-height hit area (`pointer-events-auto` above)
  // means reaching for the scrollbar always reveals it, the same cue a native
  // one gives for free (DOR-1752 finding 6.7).
  const handleTrackPointerEnter = useCallback(() => {
    isHoveringRef.current = true;
    showThumb();
  }, [showThumb]);

  const handleTrackPointerLeave = useCallback(() => {
    isHoveringRef.current = false;
    scheduleFade();
  }, [scheduleFade]);

  // Update thumb position and size on scroll
  const updateThumb = useCallback(() => {
    const el = scrollRef.current;
    const thumb = thumbRef.current;
    const track = trackRef.current;
    if (!el || !thumb || !track) return;

    const { scrollTop, scrollHeight, clientHeight } = el;
    if (scrollHeight <= clientHeight) {
      thumb.style.display = 'none';
      return;
    }
    thumb.style.display = '';

    const trackHeight = track.clientHeight;
    const ratio = clientHeight / scrollHeight;
    const thumbHeight = Math.max(ratio * trackHeight, MIN_THUMB_HEIGHT);
    const maxOffset = trackHeight - thumbHeight;
    const scrollRatio = scrollTop / (scrollHeight - clientHeight);
    const offset = scrollRatio * maxOffset;

    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${offset}px)`;
  }, [scrollRef]);

  // Listen to scroll events
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onScroll = () => {
      showThumb();
      updateThumb();
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    // Initial position
    updateThumb();

    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollRef, showThumb, updateThumb]);

  // Track click: jump to position
  const handleTrackClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === thumbRef.current) return;
      const el = scrollRef.current;
      const track = trackRef.current;
      if (!el || !track) return;

      const trackRect = track.getBoundingClientRect();
      const clickRatio = (e.clientY - trackRect.top) / trackRect.height;
      el.scrollTop = clickRatio * (el.scrollHeight - el.clientHeight);
    },
    [scrollRef]
  );

  // Thumb drag
  const handleThumbPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      isDraggingRef.current = true;
      dragStartYRef.current = e.clientY;
      dragStartScrollTopRef.current = scrollRef.current?.scrollTop ?? 0;

      const onMove = (ev: PointerEvent) => {
        const el = scrollRef.current;
        const track = trackRef.current;
        if (!el || !track) return;

        const deltaY = ev.clientY - dragStartYRef.current;
        const trackHeight = track.clientHeight;
        const ratio = el.clientHeight / el.scrollHeight;
        const thumbHeight = Math.max(ratio * trackHeight, MIN_THUMB_HEIGHT);
        const maxOffset = trackHeight - thumbHeight;
        const scrollRange = el.scrollHeight - el.clientHeight;
        const scrollDelta = (deltaY / maxOffset) * scrollRange;

        el.scrollTop = dragStartScrollTopRef.current + scrollDelta;
      };

      const onUp = () => {
        isDraggingRef.current = false;
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        // Re-arm the fade now that the drag is over. Routed through the same
        // `isHoveringRef` check as every other path, so releasing the thumb
        // while the pointer is still over the track leaves it visible instead
        // of fading out from under a cursor that never left.
        scheduleFade();
      };

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    },
    [scrollRef, scheduleFade]
  );

  return (
    <div
      ref={trackRef}
      role="presentation"
      onClick={handleTrackClick}
      onPointerEnter={handleTrackPointerEnter}
      onPointerLeave={handleTrackPointerLeave}
      // Where the track starts is the HOST's to say, because it is a fact about
      // the host's own chrome: a session pads the top of its transcript by 3rem
      // and its thumb has to clear that pad, while a room has no pad at all.
      // Inherited as `top-12` from the session's copy of this file, the room's
      // thumb could never reach the top of its own track and read ~8% low
      // across the range.
      style={{ top: 'var(--conversation-thumb-top, 0px)' }}
      className="pointer-events-auto absolute right-0 bottom-0 z-10 w-2.5"
    >
      <div
        ref={thumbRef}
        onPointerDown={handleThumbPointerDown}
        className="bg-border hover:bg-foreground/40 absolute right-0.5 w-1.5 cursor-pointer rounded-full transition-[opacity,background-color] duration-200"
        style={{ opacity: visible ? 1 : 0 }}
      />
    </div>
  );
}
