import { createContext, useContext, type ReactNode } from 'react';

const PortalContainerContext = createContext<HTMLElement | null | undefined>(undefined);

/** Configuration shared by portable overlays in one React subtree. */
export interface UiProviderProps {
  /**
   * A caller-owned, mounted host for descendant portals. Omit or pass null to
   * retain Radix's document-body default.
   */
  portalContainer?: HTMLElement | null;
  children: ReactNode;
}

/** Supplies an optional portal host without creating markup or managing a theme. */
export function UiProvider({ portalContainer, children }: UiProviderProps) {
  return (
    <PortalContainerContext.Provider value={portalContainer}>
      {children}
    </PortalContainerContext.Provider>
  );
}

/**
 * Resolve a Radix Portal container, preserving an explicit Portal prop over the
 * nearest provider. Explicit null also wins and retains Radix's body default.
 *
 * @param explicitContainer - The Portal's own container, if supplied.
 * @returns The explicit container, the provider host, or Radix's default.
 */
export function usePortalContainer(
  explicitContainer?: Element | DocumentFragment | null
): Element | DocumentFragment | null | undefined {
  const providerContainer = useContext(PortalContainerContext);
  return explicitContainer === undefined ? (providerContainer ?? undefined) : explicitContainer;
}
