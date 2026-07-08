/**
 * Form value collection for widget `form` nodes. A `form` provides this context;
 * nested `input`/`select` nodes register their value by `name`, and the form's
 * submit merges the collected values into the agent action payload.
 *
 * @module features/gen-ui/model/form-context
 */
import { createContext, useContext } from 'react';

/** The value bag and setter a `form` exposes to its fields. */
export interface WidgetFormValue {
  /** Current field values, keyed by field `name`. */
  values: Record<string, string>;
  /** Set one field's value. */
  setValue: (name: string, value: string) => void;
}

const WidgetFormContext = createContext<WidgetFormValue | null>(null);

/** Provider component for a widget form's value bag. */
export const WidgetFormProvider = WidgetFormContext.Provider;

/**
 * Access the enclosing widget form's value bag, or `null` when a field is
 * rendered outside a `form` (in which case it manages its own local state).
 */
export function useWidgetForm(): WidgetFormValue | null {
  return useContext(WidgetFormContext);
}
