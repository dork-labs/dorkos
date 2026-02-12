---
name: organizing-fsd-architecture
description: Guides organization of code using Feature-Sliced Design (FSD) architecture. Use when structuring projects, creating new features, determining file and layer placement, or reviewing architectural decisions.
---

# Organizing FSD Architecture

## Overview

This Skill provides expertise for implementing Feature-Sliced Design (FSD) architecture in frontend applications. FSD is a methodology for organizing code by business domains with clear layer boundaries and dependency rules.

## When to Use

- Setting up new project structure
- Creating new features, widgets, or entities
- Deciding where code should live (which layer)
- Reviewing imports for layer violations
- Refactoring monolithic components into FSD structure
- Organizing shared utilities and components

## Key Concepts

### Layer Hierarchy

FSD uses a strict top-to-bottom dependency flow:

```
app → widgets → features → entities → shared
```

| Layer       | Purpose                                        | Can Import From            |
| ----------- | ---------------------------------------------- | -------------------------- |
| `app/`      | Application initialization, routing, providers | All lower layers           |
| `widgets/`  | Large UI compositions                          | features, entities, shared |
| `features/` | Complete user-facing functionality             | entities, shared           |
| `entities/` | Business domain objects (User, Project, etc.)  | shared only                |
| `shared/`   | Reusable utilities, UI components, types       | Nothing (base layer)       |

### Dependency Rules (Critical)

```
✅ ALLOWED: Higher layer imports from lower layer
   features/auth/ui/LoginForm.tsx → entities/user/model/types.ts
   widgets/dashboard/ui/Overview.tsx → features/stats/ui/StatsCard.tsx

❌ FORBIDDEN: Lower layer imports from higher layer
   entities/user/api/queries.ts → features/auth/model/hooks.ts
   shared/ui/Button.tsx → entities/user/ui/UserAvatar.tsx

❌ FORBIDDEN: Same-level cross-imports (usually)
   features/auth/ → features/profile/
   entities/user/ → entities/project/
```

### Standard Segments

Each layer's modules follow this internal structure:

```
[layer]/[module-name]/
├── ui/          # React components, JSX
├── model/       # Business logic, hooks, stores, types
├── api/         # Server actions, data fetching
├── lib/         # Pure utilities, helpers
├── config/      # Constants, configuration
└── index.ts     # Public API exports
```

## Step-by-Step Approach

### 1. Determine the Correct Layer

Ask these questions in order:

```
Is it a reusable utility, UI primitive, or type?
└─ YES → shared/

Is it a core business entity (User, Project, Order)?
└─ YES → entities/[entity-name]/

Is it a complete user-facing feature?
└─ YES → features/[feature-name]/

Is it a large composition of multiple features?
└─ YES → widgets/[widget-name]/

Is it routing, providers, or app initialization?
└─ YES → app/
```

### 2. Create the Module Structure

```bash
# For a new feature
mkdir -p src/layers/features/user-authentication/{ui,model,api,lib,config}
touch src/layers/features/user-authentication/index.ts

# For a new entity
mkdir -p src/layers/entities/order/{ui,model,api,lib,config}
touch src/layers/entities/order/index.ts
```

### 3. Define the Public API

Only export what other layers need:

```typescript
// features/user-authentication/index.ts
// ✅ Export public components and hooks
export { LoginForm } from './ui/LoginForm';
export { SignupForm } from './ui/SignupForm';
export { useAuthState } from './model/useAuthState';
export type { AuthUser } from './model/types';

// ❌ Don't export internal implementations
// export { validatePassword } from './lib/validators';  // Keep internal
```

### 4. Implement with Correct Imports

```typescript
// ✅ CORRECT: Feature imports from entity and shared
// features/user-profile/ui/ProfileForm.tsx
import { Button } from '@/layers/shared/ui';
import { useUser } from '@/layers/entities/user';
import { updateProfileAction } from '../api/actions';

// ❌ WRONG: Feature imports from another feature
// import { useAuth } from '@/layers/features/auth';  // Layer violation!
```

### 5. Handle Cross-Feature Communication

When features need to communicate:

```typescript
// Option 1: Lift shared logic to entities layer
// entities/user/model/useCurrentUser.ts (shared across features)

// Option 2: Use event bus or context at app layer
// app/providers/AuthProvider.tsx (provides auth state to all features)

// Option 3: Pass data through props from widget/app
// widgets/dashboard/ui/Dashboard.tsx composes features with shared state
```

## Layer Placement Guide

| Code Type                  | Layer                    | Example Path                      |
| -------------------------- | ------------------------ | --------------------------------- |
| Button, Input, Card        | `shared/ui/`             | `shared/ui/Button.tsx`            |
| formatDate, debounce       | `shared/lib/`            | `shared/lib/date.ts`              |
| User, Project, Order types | `entities/[name]/model/` | `entities/user/model/types.ts`    |
| User CRUD operations       | `entities/[name]/api/`   | `entities/user/api/queries.ts`    |
| UserAvatar, UserBadge      | `entities/[name]/ui/`    | `entities/user/ui/UserAvatar.tsx` |
| Login form + logic         | `features/auth/`         | `features/auth/ui/LoginForm.tsx`  |
| Complete dashboard section | `widgets/`               | `widgets/stats-overview/ui/`      |
| Route pages                | `app/`                   | `app/dashboard/page.tsx`          |

## Best Practices

- **Public API via index.ts**: Every module exports only its public API through index.ts
- **Segment by purpose**: Use ui/, model/, api/, lib/, config/ consistently
- **Flat structure**: Avoid deep nesting within modules (max 2-3 levels)
- **Co-locate tests**: Place tests next to the code they test
- **Import from index**: Always import from module index, not internal files

```typescript
// ✅ CORRECT: Import from module's public API
import { UserCard, getUsersSecure } from '@/layers/entities/user';

// ❌ WRONG: Import from internal path
import { UserCard } from '@/layers/entities/user/ui/UserCard';
```

## Common Pitfalls

- **Putting everything in shared/**: Only truly reusable, domain-agnostic code belongs in shared
- **Feature-to-feature imports**: Features should not import from each other; lift shared logic to entities
- **Skipping layers**: Don't import directly from shared in app/; go through the proper layer chain
- **Circular dependencies**: Usually indicates wrong layer placement or missing abstraction
- **Giant features**: If a feature has 20+ files, consider splitting into multiple features or extracting entities

## Detecting Layer Violations

```bash
# Find potential violations: features importing from other features
grep -r "from '@/layers/features/" src/layers/features/ --include="*.ts" --include="*.tsx" | grep -v "__tests__"

# Find entities importing from features (should be 0)
grep -r "from '@/layers/features/" src/layers/entities/ --include="*.ts"

# Find shared importing from anywhere except shared
grep -r "from '@/layers/" src/layers/shared/ --include="*.ts" | grep -v "from '@/layers/shared"
```

## References

- `developer-guides/01-project-structure.md` — Full FSD patterns and Next.js integration
