import { createContext, useContext, ReactNode } from 'react';
import { App } from 'obsidian';

interface ObsidianContextValue {
  app: App;
}

const ObsidianContext = createContext<ObsidianContextValue | null>(null);

export function ObsidianProvider({ app, children }: { app: App; children: ReactNode }) {
  return <ObsidianContext.Provider value={{ app }}>{children}</ObsidianContext.Provider>;
}

export function useObsidian(): ObsidianContextValue {
  const ctx = useContext(ObsidianContext);
  if (!ctx) throw new Error('useObsidian must be used within ObsidianProvider');
  return ctx;
}
