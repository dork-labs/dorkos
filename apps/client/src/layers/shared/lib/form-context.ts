import { createFormHookContexts } from '@tanstack/react-form';

/**
 * Shared TanStack Form contexts.
 *
 * Split into its own module so field components can import `useFieldContext`
 * without creating a circular dependency with `form.ts`.
 *
 * @module shared/lib/form-context
 */
export const { fieldContext, formContext, useFieldContext, useFormContext } =
  createFormHookContexts();
