---
description: Apply pending Prisma migrations and regenerate client
argument-hint: "(no arguments)"
allowed-tools: Bash, Read, Grep
category: database
---

# Database Migrate

Apply pending Prisma migrations to the database and regenerate the Prisma client.

## Task

### Step 1: Check Current Status

Review pending migrations and current schema:

```bash
# Check migration status
pnpm prisma migrate status

# Show current schema briefly
head -30 prisma/schema.prisma
```

### Step 2: Apply Migrations

Run `prisma migrate deploy` to apply any pending migrations:

```bash
pnpm prisma migrate deploy
```

This command:
- ✅ Works in non-interactive environments
- ✅ Only applies existing migration files
- ✅ Safe for production use
- ❌ Does NOT create new migrations

### Step 3: Regenerate Prisma Client

After migrations are applied, regenerate the client to ensure types are up to date:

```bash
pnpm prisma generate
```

### Step 4: Validate

Verify the client was generated successfully:

```bash
# Check generated client exists
ls -la src/generated/prisma/

# Quick type check
pnpm typecheck
```

## Output Format

```
📦 Database Migration Complete

Status:
  ✅ Applied X pending migration(s)
  ✅ Prisma client regenerated
  ✅ Types validated

Applied migrations:
  - 20240101_initial_schema
  - 20240115_add_user_roles
```

Or if no migrations pending:

```
📦 Database Migration Status

  ℹ️  No pending migrations
  ✅ Database schema is up to date
  ✅ Prisma client regenerated
```

## Notes

- This command only applies EXISTING migrations from `prisma/migrations/`
- To CREATE new migrations, run `pnpm prisma migrate dev --name <name>` in your terminal
- For schema prototyping without migrations, use `pnpm prisma db push` (destructive)

## Edge Cases

- If migrations fail, show the error and suggest checking:
  - Database connection (`DATABASE_URL`)
  - Migration history consistency
  - Schema validity (`pnpm prisma validate`)
