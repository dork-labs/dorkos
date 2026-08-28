'use client';

import { useCallback, useState } from 'react';
import { FAQSection, FeatureCatalogSection } from '@/layers/features/marketing';
import { CastBridge } from './cast/CastBridge';
import { CloseSection } from './CloseSection';
import { FilmSection } from './film/FilmSection';
import { Hero } from './Hero';
import { StageSection } from './stage/StageSection';
import { TUTORIALS, TutorialsSection } from './tutorials';

/**
 * The page in eight moves: the claim, the film, the turn, the proof, the
 * shelf, the catalogue, the objections, the ask.
 *
 * The first four are the argument and their order is the whole bet. The film
 * is the best thing this product has and it plays in under a minute, so it
 * goes second, while the visitor is still new — not last, where a film is a
 * bonus feature nobody reaches. Everything after it exists to answer the
 * question the film leaves behind, which is whether any of that was real: the
 * cast walks out of the last frame and into a live chat, and the chat only
 * ever does things the product actually ships.
 *
 * The last four are what a visitor who is now interested goes looking for, in
 * the order they go looking. Clips, because someone sold by one film wants
 * another. Then the catalogue, for the reader who has stopped watching and
 * started checking. Then the questions that stand between them and an install.
 * Then the ask. Nothing down here argues; the argument is finished by the time
 * the stage ends, and a page that keeps arguing past its own close is a page
 * that does not trust what it said.
 *
 * The two catalogue sections come from the shared marketing layer, imported
 * and rendered unmodified. `/features` and `/compare` render the same catalog,
 * and the FAQ answers the same questions everywhere — reimplementing either
 * one here would fork the feature list and the FAQ into copies that drift. Each gets a wrapper
 * that carries the pill's anchor id and takes focus when the pill scrolls to
 * it, and nothing else.
 *
 * `joined` binds the two halves of the film-to-product hand-off. When the
 * pinned stage reports the chat is live, the agents fly out of their bridge
 * cards (shared layout ids) into the chat's member row, and fly home again on
 * the way back up. It lives here because the two sections are siblings and
 * neither owns the other.
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
      <TutorialsSection config={TUTORIALS} />
      <div id="features" tabIndex={-1} className="focus:outline-none">
        <FeatureCatalogSection />
      </div>
      <div id="questions" tabIndex={-1} className="focus:outline-none">
        <FAQSection />
      </div>
      <CloseSection />
    </>
  );
}
