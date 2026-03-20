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
  const dragStartYRef = useRef(0);
  const dragStartScrollTopRef = useRef(0);

  const showThumb = useCallback(() => {
    setVisible(true);
    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    fadeTimerRef.current = setTimeout(() => {
      if (!isDraggingRef.current) setVisible(false);
    }, FADE_DELAY_MS);
  }, []);

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
        // Start fade timer after drag ends
        if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
        fadeTimerRef.current = setTimeout(() => setVisible(false), FADE_DELAY_MS);
      };

      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    },
    [scrollRef]
  );

  return (
    <div
      ref={trackRef}
      role="presentation"
      onClick={handleTrackClick}
      className="pointer-events-auto absolute top-12 right-0 bottom-0 z-10 w-2.5"
    >
      <div
        ref={thumbRef}
        onPointerDown={handleThumbPointerDown}
        className="absolute right-0.5 w-1.5 cursor-pointer rounded-full bg-border transition-opacity duration-200"
        style={{ opacity: visible ? 1 : 0 }}
      />
    </div>
  );
}
