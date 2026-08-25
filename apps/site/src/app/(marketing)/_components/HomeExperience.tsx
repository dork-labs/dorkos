'use client';

import { useCallback, useState } from 'react';
import { CloseSection } from './CloseSection';
import { Hero } from './Hero';
import { StageSection } from './StageSection';

/**
 * Binds the hero to the pinned stage so the page reads as one continuous
 * animation: when the stage reports the chat is live, the hero's robots fly
 * out of their cards (shared layout ids) into the chat's member row — and
 * fly home again when the visitor scrolls back up.
 */
export function HomeExperience() {
  const [joined, setJoined] = useState(false);
  const handleJoinedChange = useCallback((next: boolean) => setJoined(next), []);
  return (
    <>
      <Hero joined={joined} />
      <StageSection onJoinedChange={handleJoinedChange} />
      <CloseSection />
    </>
  );
}
