import { createContext, useContext } from 'react';
import type { WidgetChannelPort } from './widget-channel';

/** Current replay state is display data; it grants no interaction authority. */
const WidgetStateContext = createContext<WidgetChannelPort['snapshot']>(undefined);
export const WidgetStateProvider = WidgetStateContext.Provider;

/** Read the current host-owned snapshot without replacing the widget subtree. */
export function useWidgetState() {
  return useContext(WidgetStateContext);
}
