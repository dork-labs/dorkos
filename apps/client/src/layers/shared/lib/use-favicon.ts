import { useEffect, useRef, useCallback } from 'react';
import {
  hashToHslColor,
  generateCircleFavicon,
  generatePulseFrames,
  setFavicon,
} from './favicon-utils';

interface UseFaviconOptions {
  cwd: string | null;
  isStreaming: boolean;
}

/** ms per frame — 20 frames × 100ms = 2s per full breathing cycle */
const FRAME_INTERVAL = 100;

export function useFavicon({ cwd, isStreaming }: UseFaviconOptions) {
  const solidRef = useRef<string>('');
  const framesRef = useRef<string[]>([]);
  const intervalRef = useRef<number | null>(null);
  const frameIndexRef = useRef(0);
  const isStreamingRef = useRef(isStreaming);
  isStreamingRef.current = isStreaming;

  const startPulsing = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (framesRef.current.length === 0) return;

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

  // Generate favicon when cwd changes
  useEffect(() => {
    if (!cwd) return;

    const color = hashToHslColor(cwd);
    const solid = generateCircleFavicon(color);
    solidRef.current = solid;
    framesRef.current = [];
    setFavicon(solid);

    // Pre-generate pulse frames; if streaming is active when they resolve, start pulsing
    let cancelled = false;
    generatePulseFrames(solid).then((frames) => {
      if (cancelled) return;
      framesRef.current = frames;
      if (isStreamingRef.current) {
        startPulsing();
      }
    });

    return () => { cancelled = true; };
  }, [cwd, startPulsing]);

  // React to streaming state changes
  useEffect(() => {
    if (isStreaming) {
      startPulsing();
    } else {
      stopPulsing();
    }

    return stopPulsing;
  }, [isStreaming, startPulsing, stopPulsing]);
}
