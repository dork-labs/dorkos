# Forms & Validation Guide

## Overview

This project uses React Hook Form + Zod + Shadcn Form for type-safe form handling with declarative validation. Forms use `zodResolver` to connect Zod schemas to React Hook Form, providing runtime validation that matches TypeScript types.

## Key Files

| Concept | Location |
|---------|----------|
| Form components | `src/layers/shared/ui/form.tsx` |
| Example schemas | `src/layers/entities/user/model/types.ts` |
| Auth forms (reference) | `src/layers/features/auth/ui/` |
| Shadcn Form docs | `@/components/ui/form` |

## When to Use What

| Scenario | Approach | Why |
|----------|----------|-----|
| Simple form (1-3 fields) | React Hook Form + zodResolver | Type safety, automatic error handling |
| Complex form (validation logic) | Zod refine/superRefine | Custom validation with typed errors |
| Multi-step form | React Hook Form + Zustand | Form state in RHF, step state in Zustand |
| Server errors (auth, network) | `form.setError('root', ...)` | Displays server errors above form |
| Field-specific server errors | `form.setError(fieldName, ...)` | Ties error to specific field |
| Dynamic fields (arrays) | `useFieldArray` hook | Add/remove fields with proper state management |
| Form reset after submit | `form.reset()` | Clears all fields and errors |
| Optimistic UI updates | TanStack Query mutation + `onMutate` | See data-fetching guide |

## Core Patterns

### Basic Form with Validation

```typescript
// src/layers/features/example/ui/ExampleForm.tsx
'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button } from '@/layers/shared/ui/button'
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/layers/shared/ui/form'
import { Input } from '@/layers/shared/ui/input'

// 1. Define schema with validation rules
const formSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  email: z.string().email('Invalid email address'),
})

type FormData = z.infer<typeof formSchema>

export function ExampleForm() {
  // 2. Initialize form with zodResolver
  const form = useForm<FormData>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '',
      email: '',
    },
  })

  // 3. Handle submission (data is validated)
  async function onSubmit(data: FormData) {
    console.log('Validated data:', data)
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
        <FormField
          control={form.control}
          name="name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Name</FormLabel>
              <FormControl>
                <Input {...field} />
              </FormControl>
              <FormDescription>Your display name.</FormDescription>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input type="email" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" disabled={form.formState.isSubmitting}>
          Submit
        </Button>
      </form>
    </Form>
  )
}
```

### Common Validation Patterns

```typescript
import { z } from 'zod'

const schema = z.object({
  // Required string with min length
  name: z.string().min(1, 'Required'),

  // Email validation
  email: z.string().email('Invalid email address'),

  // URL validation
  website: z.string().url('Invalid URL'),

  // Number with range
  age: z.number().min(18, 'Must be 18+').max(120),

  // Enum (select/radio)
  role: z.enum(['admin', 'user', 'guest']),

  // Optional field
  bio: z.string().optional(),

  // Array with min items
  tags: z.array(z.string()).min(1, 'At least one tag required'),

  // Nested object
  address: z.object({
    street: z.string(),
    city: z.string(),
    zipCode: z.string().regex(/^\d{5}$/, 'Invalid zip code'),
  }),

  // Boolean (checkbox)
  agreedToTerms: z.boolean().refine((val) => val === true, {
    message: 'You must agree to the terms',
  }),
})
```

### Cross-Field Validation (Password Confirmation)

```typescript
import { z } from 'zod'

const passwordSchema = z.object({
  password: z.string().min(8, 'Password must be at least 8 characters'),
  confirmPassword: z.string(),
}).refine((data) => data.password === data.confirmPassword, {
  message: "Passwords don't match",
  path: ['confirmPassword'], // Error appears on confirmPassword field
})
```

### Server Action Submission with Error Handling

```typescript
'use client'

import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { createUser } from '@/app/actions/user'
import { userSchema, type UserFormData } from '@/layers/entities/user'

export function CreateUserForm() {
  const form = useForm<UserFormData>({
    resolver: zodResolver(userSchema),
    defaultValues: { name: '', email: '' },
  })

  async function onSubmit(data: UserFormData) {
    try {
      await createUser(data)
      form.reset() // Clear form on success
    } catch (error) {
      // Display server error above form
      form.setError('root', {
        message: error instanceof Error ? error.message : 'Failed to create user',
      })
    }
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)}>
        {/* Show root error if exists */}
        {form.formState.errors.root && (
          <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
            {form.formState.errors.root.message}
          </div>
        )}
        {/* Form fields... */}
      </form>
    </Form>
  )
}
```

### Dynamic Fields with useFieldArray

```typescript
import { useForm, useFieldArray } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { Button } from '@/layers/shared/ui/button'

const schema = z.object({
  items: z.array(z.object({
    name: z.string().min(1),
    quantity: z.number().min(1),
  })).min(1, 'At least one item required'),
})

type FormData = z.infer<typeof schema>

export function DynamicForm() {
  const form = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: {
      items: [{ name: '', quantity: 1 }],
    },
  })

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: 'items',
  })

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit((data) => console.log(data))}>
        {fields.map((field, index) => (
          <div key={field.id} className="flex gap-2">
            <FormField
              control={form.control}
              name={`items.${index}.name`}
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <Input {...field} placeholder="Item name" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button
              type="button"
              variant="destructive"
              onClick={() => remove(index)}
            >
              Remove
            </Button>
          </div>
        ))}
        <Button
          type="button"
          onClick={() => append({ name: '', quantity: 1 })}
        >
          Add Item
        </Button>
        <Button type="submit">Submit</Button>
      </form>
    </Form>
  )
}
```

## Anti-Patterns

```typescript
// ❌ NEVER skip zodResolver — loses type safety and validation
const form = useForm<UserFormData>({
  defaultValues: { name: '', email: '' },
})

// ✅ Always use zodResolver
const form = useForm<UserFormData>({
  resolver: zodResolver(userSchema),
  defaultValues: { name: '', email: '' },
})
```

```typescript
// ❌ Don't manually manage input state
const [email, setEmail] = useState('')
<Input value={email} onChange={(e) => setEmail(e.target.value)} />

// ✅ Use FormField render prop
<FormField
  control={form.control}
  name="email"
  render={({ field }) => (
    <FormControl>
      <Input {...field} />
    </FormControl>
  )}
/>
```

```typescript
// ❌ Don't access form.formState outside component (causes unnecessary re-renders)
const { errors } = form.formState
if (errors.email) { /* ... */ }

// ✅ Use FormMessage component (only re-renders when field error changes)
<FormMessage />
```

```typescript
// ❌ Don't forget to disable submit during submission
<Button type="submit">Submit</Button>

// ✅ Disable button to prevent double-submit
<Button type="submit" disabled={form.formState.isSubmitting}>
  {form.formState.isSubmitting ? 'Submitting...' : 'Submit'}
</Button>
```

```typescript
// ❌ Don't use form validation for server-side-only checks
const schema = z.object({
  email: z.string().email().refine(async (email) => {
    const exists = await checkEmailExists(email) // Async network call
    return !exists
  }, { message: 'Email already exists' })
})

// ✅ Check server errors in onSubmit, use setError
async function onSubmit(data: FormData) {
  const result = await createUser(data)
  if (result.error === 'EMAIL_EXISTS') {
    form.setError('email', { message: 'Email already exists' })
    return
  }
  // Success...
}
```

## Shadcn Form Component Reference

| Component | Purpose | When to Use |
|-----------|---------|-------------|
| `Form` | Provides form context via `<Form {...form}>` | Required wrapper for all Shadcn forms |
| `FormField` | Connects field to React Hook Form | Every input needs this |
| `FormItem` | Groups label, input, description, error | Container for field elements |
| `FormLabel` | Field label with accessibility | Always use instead of raw `<label>` |
| `FormControl` | Wraps input component | Direct parent of `Input`, `Select`, etc. |
| `FormDescription` | Helper text below input | Optional guidance for users |
| `FormMessage` | Validation error display | Automatic — shows errors from Zod |

## Adding a New Form

1. **Define Zod schema** in the entity's `model/types.ts`:
   ```typescript
   // src/layers/entities/user/model/types.ts
   export const createUserSchema = z.object({
     name: z.string().min(2),
     email: z.string().email(),
   })

   export type CreateUserInput = z.infer<typeof createUserSchema>
   ```

2. **Create form component** in the feature's `ui/` directory:
   ```typescript
   // src/layers/features/user-management/ui/CreateUserForm.tsx
   'use client'

   import { useForm } from 'react-hook-form'
   import { zodResolver } from '@hookform/resolvers/zod'
   import { createUserSchema, type CreateUserInput } from '@/layers/entities/user'

   export function CreateUserForm() {
     const form = useForm<CreateUserInput>({
       resolver: zodResolver(createUserSchema),
       defaultValues: { name: '', email: '' },
     })

     // Implementation...
   }
   ```

3. **Create server action** (if needed):
   ```typescript
   // src/app/actions/user.ts
   'use server'

   import { createUser as createUserDal } from '@/layers/entities/user'
   import { createUserSchema } from '@/layers/entities/user'

   export async function createUser(data: unknown) {
     const validated = createUserSchema.parse(data)
     return createUserDal(validated)
   }
   ```

4. **Verify**: Check form validation by intentionally triggering errors (submit empty, invalid email, etc.)

## Troubleshooting

### "Type 'unknown' is not assignable to type..."

**Cause**: Not using `zodResolver`, so form doesn't know field types.
**Fix**: Add `resolver: zodResolver(schema)` to `useForm` options.

### Form submits without validation

**Cause**: One of:
1. Not using `form.handleSubmit(onSubmit)` in `onSubmit` prop
2. Forgot `resolver: zodResolver(schema)`
3. Schema allows empty values (e.g., `z.string().optional()` when you meant required)

**Fix**: Check all three causes. Most common is forgetting `handleSubmit`.

### Validation errors don't display

**Cause**: Missing `<FormMessage />` component in `FormField`.
**Fix**: Ensure each `FormField` has `<FormMessage />` inside `FormItem`:
```typescript
<FormField
  name="email"
  render={({ field }) => (
    <FormItem>
      <FormLabel>Email</FormLabel>
      <FormControl>
        <Input {...field} />
      </FormControl>
      <FormMessage /> {/* Required for error display */}
    </FormItem>
  )}
/>
```

### "Cannot read property 'control' of undefined"

**Cause**: Not spreading `{...form}` into `<Form>` component.
**Fix**:
```typescript
// ❌ Wrong
<Form>
  <form>...</form>
</Form>

// ✅ Correct
<Form {...form}>
  <form>...</form>
</Form>
```

### Input value doesn't update

**Cause**: Not spreading `{...field}` into input component.
**Fix**:
```typescript
<FormField
  name="email"
  render={({ field }) => (
    <FormControl>
      <Input {...field} /> {/* Spreads value, onChange, onBlur, etc. */}
    </FormControl>
  )}
/>
```

### Server errors don't show

**Cause**: Not using `form.setError()` to display server errors.
**Fix**: Use `setError('root', ...)` for general errors or `setError(fieldName, ...)` for field-specific:
```typescript
async function onSubmit(data: FormData) {
  try {
    await submitToServer(data)
  } catch (error) {
    form.setError('root', {
      message: error instanceof Error ? error.message : 'Submission failed',
    })
  }
}

// Then render root errors:
{form.formState.errors.root && (
  <div className="text-sm text-destructive">
    {form.formState.errors.root.message}
  </div>
)}
```

## References

- [React Hook Form Documentation](https://react-hook-form.com/get-started)
- [Zod Documentation](https://zod.dev/)
- [Shadcn Form Component](https://ui.shadcn.com/docs/components/form)
- [Data Fetching Guide](./05-data-fetching.md) - TanStack Query mutations with forms
- [Authentication Guide](./09-authentication.md) - Example forms in auth flow
