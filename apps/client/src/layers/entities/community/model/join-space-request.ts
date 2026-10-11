/**
 * A request to open the Join dialog on one space's link, from anywhere in the app (spec
 * `official-community-space` D5).
 *
 * The Join dialog lives with the context switcher, which is always mounted in the app's chrome.
 * A surface elsewhere (the offer to join the DorkOS community, in onboarding or after linking a
 * DorkOS account) cannot import it, so it asks here, and the switcher takes the request and
 * opens its dialog with the link filled in. Taking clears it, so two mounted switchers open one
 * dialog between them.
 *
 * @module entities/community/model/join-space-request
 */
import { create } from 'zustand';

/** The one pending request to open the Join dialog. */
export interface JoinSpaceRequestState {
  /** The link to fill in, or `null` when nothing is asked. */
  url: string | null;
  /** Ask for the Join dialog on this link. */
  ask: (url: string) => void;
  /** Take the pending link, clearing it, or `null` when another reader took it first. */
  take: () => string | null;
}

/** The app-wide Join request, read by the context switcher. */
export const useJoinSpaceRequest = create<JoinSpaceRequestState>()((set, get) => ({
  url: null,
  ask: (url) => set({ url }),
  take: () => {
    const { url } = get();
    if (url !== null) set({ url: null });
    return url;
  },
}));
