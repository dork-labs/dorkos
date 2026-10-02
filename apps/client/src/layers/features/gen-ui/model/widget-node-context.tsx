import { createContext, useContext } from 'react';
/** A host-rendered structural path identifies the native control; it grants no authority. */
const WidgetNodeContext = createContext('root');
/** Stable structural path provider for recursive widget rendering. */
export const WidgetNodeProvider = WidgetNodeContext.Provider;
/** Read the rendered node's structural identity. */
export function useWidgetNodePath(): string {
  return useContext(WidgetNodeContext);
}
