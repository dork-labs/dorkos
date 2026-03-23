import { createFormHook } from '@tanstack/react-form';
import { TextField } from '@/layers/shared/ui/form-fields/TextField';
import { TextareaField } from '@/layers/shared/ui/form-fields/TextareaField';
import { SelectField } from '@/layers/shared/ui/form-fields/SelectField';
import { SwitchField } from '@/layers/shared/ui/form-fields/SwitchField';
import { CheckboxField } from '@/layers/shared/ui/form-fields/CheckboxField';
import { PasswordField } from '@/layers/shared/ui/form-fields/PasswordField';
import { SubmitButton } from '@/layers/shared/ui/form-fields/SubmitButton';
import { fieldContext, formContext } from '@/layers/shared/lib/form-context';

export { formOptions } from '@tanstack/react-form';
export { useFieldContext, useFormContext } from '@/layers/shared/lib/form-context';

/**
 * App-wide TanStack Form hook with pre-wired field and form components.
 *
 * Use `useAppForm` in place of the bare `useForm` hook to get typed `AppField`
 * and `AppForm` components that include the full DorkOS field library.
 *
 * Use `withForm` to create form sub-components that receive a fully-typed form
 * instance as a prop without threading it through manually.
 *
 * @example
 * ```tsx
 * const form = useAppForm({ defaultValues: { name: '' } });
 * return (
 *   <form.AppForm>
 *     <form.AppField name="name">
 *       {(field) => <field.TextField label="Name" />}
 *     </form.AppField>
 *     <form.SubmitButton label="Save" />
 *   </form.AppForm>
 * );
 * ```
 *
 * @module shared/lib/form
 */
export const { useAppForm, withForm } = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: {
    TextField,
    TextareaField,
    SelectField,
    SwitchField,
    CheckboxField,
    PasswordField,
  },
  formComponents: {
    SubmitButton,
  },
});
