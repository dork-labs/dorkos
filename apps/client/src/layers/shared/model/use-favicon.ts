import { useEffect, useRef, useCallback } from 'react';
import {
  hashToHslColor,
  generateCircleFavicon,
  generateTasksFrames,
  setFavicon,
} from '@/layers/shared/lib/favicon-utils';
import { isDesktopShell } from '@/layers/shared/lib/platform';

interface UseFaviconOptions {
  cwd: string | null;
  isStreaming: boolean;
  /** Optional color override — when provided, skips hashToHslColor(cwd) */
  color?: string;
}

/** ms per frame — 20 frames × 100ms = 2s per full breathing cycle */
const FRAME_INTERVAL = 100;

/**
 * Generate a CWD-based colored favicon and tasks-animate it while streaming.
 *
 * The pulse rewrites the icon ten times a second for as long as a turn streams,
 * which can be hours. It only runs where someone can see it move (DOR-3312):
 * never in the desktop shell, whose window shows no favicon, and not while the
 * page is hidden, where one still working frame stands in for it.
 */
export function useFavicon({ cwd, isStreaming, color: colorOverride }: UseFaviconOptions) {
  const solidRef = useRef<string>('');
  const framesRef = useRef<string[]>([]);
  const intervalRef = useRef<number | null>(null);
  const frameIndexRef = useRef(0);
  const isStreamingRef = useRef(isStreaming);
  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);

  const startPulsing = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    const frames = framesRef.current;
    if (frames.length === 0) return;
    // A hidden background tab is where people check the icon: show one still
    // "working" frame, the pulse at its fullest, and run no timer until it is shown.
    if (document.visibilityState === 'hidden') {
      setFavicon(frames[Math.floor(frames.length / 2)]);
      return;
    }

    frameIndexRef.current = 0;
    intervalRef.current = window.setInterval(() => {
      const frames = framesRef.current;
      if (frames.length === 0) return;
      setFavicon(frames[frameIndexRef.current]);
      frameIndexRef.current = (frameIndexRef.current + 1) % frames.length;
    }, FRAME_INTERVAL);
  }, []);

  const stopPulsing = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (solidRef.current) {
      setFavicon(solidRef.current);
    }
  }, []);

  // Generate favicon when cwd or color override changes
  useEffect(() => {
    if (!cwd) return;

    const color = colorOverride ?? hashToHslColor(cwd);
    const solid = generateCircleFavicon(color);
    solidRef.current = solid;
    framesRef.current = [];
    setFavicon(solid);
    if (isDesktopShell()) return;

    // Pre-generate tasks frames; if streaming is active when they resolve, start pulsing
    let cancelled = false;
    generateTasksFrames(solid)
      .then((frames) => {
        if (cancelled) return;
        framesRef.current = frames;
        if (isStreamingRef.current) {
          startPulsing();
        }
      })
      .catch(() => {
        // Static favicon remains as graceful fallback
      });

    return () => {
      cancelled = true;
    };
  }, [cwd, colorOverride, startPulsing]);

  // React to streaming state changes
  useEffect(() => {
    if (isStreaming) {
      startPulsing();
    } else {
      stopPulsing();
    }

    return stopPulsing;
  }, [isStreaming, startPulsing, stopPulsing]);

  // Hidden: one still working frame. Shown again: the pulse picks up.
  useEffect(() => {
    const onVisibility = () => {
      if (isStreamingRef.current) startPulsing();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [startPulsing]);
}
