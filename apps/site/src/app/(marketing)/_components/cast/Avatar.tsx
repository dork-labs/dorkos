'use client';

import { useEffect, useRef } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { SPEAKERS, type SpeakerKey } from './cast';
import { POP } from '../motion-tokens';

interface AvatarProps {
  who: SpeakerKey;
  /** Diameter in px, before the speaker's own `sizeScale` is applied. */
  size: number;
  /**
   * Lit ring plus a glow. In the film this is the only cue saying which bubble
   * belongs to which face when three are on screen.
   */
  speaking?: boolean;
  /**
   * Lit ring, no glow. The film's "I am the user, not an agent" mark, which
   * Dave carries the whole time.
   */
  ringed?: boolean;
  /** Shared-element id, so a face can fly between two places on the page. */
  layoutId?: string;
}

/**
 * A face from the film, playing its own loop.
 *
 * The four clips are 720x720, ping-ponged in ffmpeg so the seam is
 * mathematically identical rather than merely close, and they carry no audio
 * stream at all. `muted` is set anyway: Safari gates autoplay on the attribute,
 * not on what the file contains. `playsInline` is the one that actually bites,
 * because without it iOS takes a decorative avatar fullscreen.
 *
 * Each clip loops at its own length, which the browser reads off the file.
 * Dave's is 2.83s and the agents' are 10.08s, and a hand-rolled player that
 * assumed one length cost the film project a day.
 *
 * Reduced motion gets the still, and gets it from this same element: the
 * `poster` IS the still, and a video that is never told to play never leaves
 * it. Choosing between an `<img>` and a `<video>` on the preference would be a
 * different element type on the server (which cannot know the preference) than
 * on a reduced-motion client, which is a hydration mismatch — React throws
 * #418 and re-renders the whole tree on the client for exactly the visitors
 * who asked for less work. One element, and the preference decides only
 * whether `play()` is ever called.
 */
export function Avatar({ who, size, speaking = false, ringed = false, layoutId }: AvatarProps) {
  const member = SPEAKERS[who];
  const reduced = useReducedMotion();
  const videoRef = useRef<HTMLVideoElement>(null);

  // `preload="none"` keeps four 720p loops off the wire until they are wanted;
  // this starts the one that has scrolled into view and pauses it again after.
  useEffect(() => {
    const node = videoRef.current;
    if (!node || reduced) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) void node.play().catch(() => undefined);
      else node.pause();
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [reduced]);

  const diameter = Math.round(size * member.sizeScale);
  const ringWidth = speaking ? 3 : ringed ? 2.5 : 2;
  const ringColor = speaking || ringed ? member.ring : 'rgba(255,255,255,0.2)';

  return (
    <motion.span
      layoutId={layoutId}
      transition={POP}
      title={member.name}
      className="relative inline-block shrink-0 overflow-hidden rounded-full"
      style={{
        width: diameter,
        height: diameter,
        border: `${ringWidth}px solid ${ringColor}`,
        boxShadow: speaking
          ? `0 0 ${Math.round(diameter * 0.26)}px ${member.ring}66, 0 2px 8px rgba(0,0,0,0.5)`
          : '0 2px 8px rgba(0,0,0,0.5)',
      }}
    >
      <video
        ref={videoRef}
        src={member.loop}
        poster={member.still}
        muted
        loop
        playsInline
        preload="none"
        aria-hidden="true"
        className="size-full object-cover"
      />
    </motion.span>
  );
}
