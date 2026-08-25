'use client';

import { useCallback, useState } from 'react';
import { CastBridge } from './CastBridge';
import { CloseSection } from './CloseSection';
import { FilmSection } from './FilmSection';
import { Hero } from './Hero';
import { StageSection } from './StageSection';

/**
 * The page in five moves: the claim, the film, the turn, the proof, the ask.
 *
 * The order is the argument. The film is the best thing this product has and
 * it plays in under a minute, so it goes second, while the visitor is still
 * new — not last, where a film is a bonus feature nobody reaches. Everything
 * after it exists to answer the question the film leaves behind, which is
 * whether any of that was real: the cast walks out of the last frame and into
 * a live chat, and the chat only ever does things the product actually ships.
 *
 * `joined` binds the two halves of that hand-off. When the pinned stage
 * reports the chat is live, the agents fly out of their bridge cards (shared
 * layout ids) into the chat's member row, and fly home again on the way back
 * up. It lives here because the two sections are siblings and neither owns
 * the other.
 */
export function HomeExperience() {
  const [joined, setJoined] = useState(false);
  const handleJoinedChange = useCallback((next: boolean) => setJoined(next), []);
  return (
    <>
      <Hero />
      <FilmSection />
      <CastBridge joined={joined} />
      <StageSection onJoinedChange={handleJoinedChange} />
      <CloseSection />
    </>
  );
}
