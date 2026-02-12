# State Management Guide

## Overview

This guide covers state management patterns using Zustand for complex client state and TanStack Query for server state. Use the decision matrix below to choose the right tool based on state type and synchronization needs.

## Key Files

| Concept | Location |
|---------|----------|
| Store definitions | `src/stores/*.ts` (e.g., `cart-store.ts`) |
| Query client setup | `src/layers/shared/lib/query-client.ts` |
| Client providers | `src/app/providers.tsx` |
| Store types | `src/stores/*.ts` (colocated with implementation) |

## When to Use What

| State Type | Tool | Example | Why |
|------------|------|---------|-----|
| Server state | TanStack Query | User data from API | Handles caching, revalidation, background refetching |
| Complex client state | Zustand | Shopping cart, multi-step form | Persist to localStorage, global access, middleware support |
| Simple UI state | React useState | Modal open/close, toggle visibility | Scoped to component, no persistence needed |
| URL state | Next.js router | Filters, pagination, tabs | Shareable links, browser history |
| Form state | React Hook Form | Form inputs, validation | Optimized for forms, integrates with Zod |

## Core Patterns

### Creating a Zustand Store

```typescript
// src/stores/cart-store.ts
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface CartItem {
  id: string
  name: string
  price: number
  quantity: number
}

interface CartState {
  items: CartItem[]
  addItem: (item: Omit<CartItem, 'quantity'>) => void
  removeItem: (id: string) => void
  updateQuantity: (id: string, quantity: number) => void
  clearCart: () => void
  total: () => number
}

export const useCartStore = create<CartState>()(
  persist(
    (set, get) => ({
      items: [],

      addItem: (item) => set((state) => {
        const existing = state.items.find((i) => i.id === item.id)
        if (existing) {
          return {
            items: state.items.map((i) =>
              i.id === item.id
                ? { ...i, quantity: i.quantity + 1 }
                : i
            ),
          }
        }
        return { items: [...state.items, { ...item, quantity: 1 }] }
      }),

      removeItem: (id) => set((state) => ({
        items: state.items.filter((i) => i.id !== id),
      })),

      updateQuantity: (id, quantity) => set((state) => ({
        items: state.items.map((i) =>
          i.id === id ? { ...i, quantity } : i
        ),
      })),

      clearCart: () => set({ items: [] }),

      // Computed values use get() to access current state
      total: () => get().items.reduce(
        (sum, item) => sum + item.price * item.quantity,
        0
      ),
    }),
    {
      name: 'cart-storage', // localStorage key
    }
  )
)
```

### Using Selectors (Prevent Re-renders)

```typescript
'use client'

import { useCartStore } from '@/stores/cart-store'

export function CartSummary() {
  // ✅ Use selectors - only re-renders when these specific values change
  const itemCount = useCartStore((state) => state.items.length)
  const total = useCartStore((state) => state.total)
  const clearCart = useCartStore((state) => state.clearCart)

  return (
    <div>
      <p>{itemCount} items</p>
      <p>Total: ${total()}</p>
      <button onClick={clearCart}>Clear Cart</button>
    </div>
  )
}
```

### Combining Zustand with TanStack Query

```typescript
'use client'

import { useQuery } from '@tanstack/react-query'
import { useCartStore } from '@/stores/cart-store'

export function ProductList() {
  // Server state (products from API) - use TanStack Query
  const { data: products } = useQuery({
    queryKey: ['products'],
    queryFn: fetchProducts,
  })

  // Client state (shopping cart) - use Zustand
  const addItem = useCartStore((state) => state.addItem)

  return (
    <ul>
      {products?.map((product) => (
        <li key={product.id}>
          {product.name}
          <button onClick={() => addItem(product)}>Add to Cart</button>
        </li>
      ))}
    </ul>
  )
}
```

### Persisting State to localStorage

```typescript
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export const usePreferencesStore = create()(
  persist(
    (set) => ({
      theme: 'light' as 'light' | 'dark',
      language: 'en',
      setTheme: (theme: 'light' | 'dark') => set({ theme }),
      setLanguage: (language: string) => set({ language }),
    }),
    {
      name: 'preferences-storage',          // localStorage key
      partialize: (state) => ({             // Optional: only persist some fields
        theme: state.theme,
        language: state.language,
        // Omit functions from persistence
      }),
    }
  )
)
```

### Accessing Store Outside Components

```typescript
// src/stores/cart-store.ts
export const useCartStore = create<CartState>()(/* ... */)

// Export the store itself for non-React usage
export const cartStore = useCartStore.getState

// Usage in utility functions
export function processCheckout() {
  const items = cartStore().items
  const total = cartStore().total()

  // Process checkout...
}
```

## Anti-Patterns

```typescript
// ❌ NEVER use Zustand for server state
export const useUserStore = create((set) => ({
  user: null,
  fetchUser: async () => {
    const response = await fetch('/api/user')
    const user = await response.json()
    set({ user })  // Stale data, no cache invalidation, no background refetch
  }
}))

// ✅ Use TanStack Query for server state
export function useUser() {
  return useQuery({
    queryKey: ['user'],
    queryFn: async () => {
      const response = await fetch('/api/user')
      return response.json()
    },
    staleTime: 5 * 60 * 1000,  // Automatic refetching, caching, deduplication
  })
}
```

```typescript
// ❌ Don't destructure the entire store (causes re-renders on ANY state change)
const { items, addItem, removeItem, clearCart } = useCartStore()

// ✅ Use selectors for each value (only re-renders when that specific value changes)
const items = useCartStore((state) => state.items)
const addItem = useCartStore((state) => state.addItem)
const removeItem = useCartStore((state) => state.removeItem)
const clearCart = useCartStore((state) => state.clearCart)
```

```typescript
// ❌ Don't store derived state
export const useCartStore = create((set, get) => ({
  items: [],
  total: 0,  // This will get out of sync!
  addItem: (item) => set((state) => ({
    items: [...state.items, item],
    total: state.total + item.price  // Manual calculation prone to bugs
  }))
}))

// ✅ Compute derived values on demand
export const useCartStore = create((set, get) => ({
  items: [],
  total: () => get().items.reduce((sum, item) => sum + item.price, 0)
}))
```

```typescript
// ❌ Don't use Zustand for URL-synchronized state
export const useFilterStore = create((set) => ({
  search: '',
  category: null,
  setSearch: (search) => set({ search }),
  setCategory: (category) => set({ category })
}))

// ✅ Use Next.js router for URL-synchronized state (shareable, bookmarkable)
'use client'

import { useRouter, useSearchParams } from 'next/navigation'

export function ProductFilters() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const search = searchParams.get('search') || ''
  const category = searchParams.get('category') || null

  const setSearch = (value: string) => {
    const params = new URLSearchParams(searchParams)
    params.set('search', value)
    router.push(`?${params.toString()}`)
  }

  // ...
}
```

## Step-by-Step: Creating a New Store

1. **Create the store file**: `src/stores/[name]-store.ts`
   ```typescript
   import { create } from 'zustand'

   interface MyState {
     value: string
     setValue: (value: string) => void
   }

   export const useMyStore = create<MyState>((set) => ({
     value: '',
     setValue: (value) => set({ value }),
   }))
   ```

2. **Add persistence (optional)**: Wrap with `persist` middleware
   ```typescript
   import { create } from 'zustand'
   import { persist } from 'zustand/middleware'

   export const useMyStore = create<MyState>()(
     persist(
       (set) => ({
         value: '',
         setValue: (value) => set({ value }),
       }),
       {
         name: 'my-storage',
       }
     )
   )
   ```

3. **Use in components**: Import and use selectors
   ```typescript
   'use client'

   import { useMyStore } from '@/stores/my-store'

   export function MyComponent() {
     const value = useMyStore((state) => state.value)
     const setValue = useMyStore((state) => state.setValue)

     return <input value={value} onChange={(e) => setValue(e.target.value)} />
   }
   ```

4. **Verify**: Check localStorage (if using persist) in browser DevTools → Application → Local Storage

## Troubleshooting

### Hydration mismatch with persisted state

**Cause**: Server-rendered component uses default state, but client hydrates with persisted localStorage value.

**Fix**: Use a hydration-safe pattern:
```typescript
'use client'

import { useEffect, useState } from 'react'
import { useMyStore } from '@/stores/my-store'

export function MyComponent() {
  const [isClient, setIsClient] = useState(false)
  const value = useMyStore((state) => state.value)

  useEffect(() => {
    setIsClient(true)
  }, [])

  if (!isClient) {
    return <div>Loading...</div>  // Show placeholder during SSR
  }

  return <div>{value}</div>
}
```

### Store updates not triggering re-renders

**Cause**: Mutating state directly instead of using `set()`:
```typescript
// ❌ Direct mutation doesn't trigger re-renders
addItem: (item) => {
  get().items.push(item)  // Mutates array in place
}
```

**Fix**: Always use `set()` with new references:
```typescript
// ✅ Create new array reference
addItem: (item) => set((state) => ({
  items: [...state.items, item]
}))
```

### Persist middleware not saving to localStorage

**Cause**: One of:
1. Using `create(...)` instead of `create()(...)`
2. Missing `name` option in persist config
3. localStorage not available (SSR)

**Fix**:
```typescript
// ❌ Wrong syntax
export const useStore = create(
  persist((set) => ({ /* ... */ }), { name: 'storage' })
)

// ✅ Correct syntax with double invocation
export const useStore = create()(
  persist((set) => ({ /* ... */ }), { name: 'storage' })
)
```

### Component re-renders on every store update

**Cause**: Not using selectors, or selecting too much state:
```typescript
// ❌ Re-renders on ANY store change
const store = useCartStore()
const itemCount = store.items.length
```

**Fix**: Use specific selectors:
```typescript
// ✅ Only re-renders when items.length changes
const itemCount = useCartStore((state) => state.items.length)
```

### "Cannot use store outside React components"

**Cause**: Trying to call `useCartStore()` in a non-React function.

**Fix**: Export and use `getState()` for non-React usage:
```typescript
// src/stores/cart-store.ts
export const useCartStore = create<CartState>()(/* ... */)
export const cartStore = useCartStore.getState  // Export store getter

// src/lib/analytics.ts
import { cartStore } from '@/stores/cart-store'

export function trackCheckout() {
  const items = cartStore().items  // Access state outside React
  analytics.track('checkout', { items })
}
```

## References

- [Zustand Documentation](https://docs.pmnd.rs/zustand/getting-started/introduction)
- [TanStack Query Guide](./05-data-fetching.md) - Server state management patterns
- [Forms Guide](./04-forms-validation.md) - React Hook Form for form state
