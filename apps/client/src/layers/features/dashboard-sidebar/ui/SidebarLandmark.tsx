import { createContext, useContext, type ReactNode } from 'react';
import { useBootState } from '../model/boot/use-boot-state';

const InsideLandmarkContext = createContext(false);

/** Whether a {@link SidebarLandmark} already wraps this tree, so no second one is drawn. */
export function useInsideSidebarLandmark(): boolean {
  return useContext(InsideLandmarkContext);
}

/**
 * The sidebar's one landmark (R2).
 *
 * The desktop shell wraps the whole panel in it, so the header and footer are part
 * of the landmark rather than beside it. `DashboardSidebar` draws its own only when
 * nothing wraps it: on a phone it sits on the Home tab, without that chrome.
 *
 * `aria-busy` is the WHOLE announcement of a cold boot (spec D6): the skeleton
 * itself is `aria-hidden` and there is no live region reading out bones, because
 * "the sidebar is still loading" is a property of the landmark and not an event
 * worth interrupting anybody for.
 *
 * @param props.className - Layout for the landmark's own box.
 * @param props.children - What the landmark holds.
 */
export function SidebarLandmark({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  const boot = useBootState();

  return (
    <InsideLandmarkContext.Provider value={true}>
      <nav
        aria-label="Sidebar"
        aria-busy={boot.phase === 'cold' ? true : undefined}
        className={className}
      >
        {children}
      </nav>
    </InsideLandmarkContext.Provider>
  );
}
