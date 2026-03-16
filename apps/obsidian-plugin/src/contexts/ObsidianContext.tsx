import { createContext, useContext, ReactNode } from 'react';
import { App } from 'obsidian';

interface ObsidianContextValue {
  app: App;
}

const ObsidianContext = createContext<ObsidianContextValue | null>(null);

/** Provide the Obsidian App instance to descendant components. */
export function ObsidianProvider({ app, children }: { app: App; children: ReactNode }) {
  return <ObsidianContext.Provider value={{ app }}>{children}</ObsidianContext.Provider>;
}

/** Access the Obsidian App instance from React context. */
export function useObsidian(): ObsidianContextValue {
  const ctx = useContext(ObsidianContext);
  if (!ctx) throw new Error('useObsidian must be used within ObsidianProvider');
  return ctx;
}
