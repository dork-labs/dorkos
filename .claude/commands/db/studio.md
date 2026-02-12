---
description: Open Prisma Studio to view and explore the database
argument-hint: "[--port <port>] [--no-browser]"
allowed-tools: Bash, Read
category: database
---

# Database Studio

Launch Prisma Studio, a visual interface for viewing and managing database data.

## Arguments

Parse `$ARGUMENTS` for optional flags:

| Argument | Effect |
|----------|--------|
| `--port <port>` | Use custom port instead of default |
| `--no-browser` | Don't auto-open browser (useful for remote/CI) |

**Examples:**
- `/db:studio` — Open Studio with default settings
- `/db:studio --port 5555` — Open on specific port
- `/db:studio --no-browser` — Start server without opening browser

## Task

### Step 1: Parse Arguments

Extract flags from `$ARGUMENTS`:
- Check for `--port <number>` — store as `PORT`
- Check for `--no-browser` flag — store as `NO_BROWSER=true`

### Step 2: Build Command

Construct the prisma studio command:

```bash
# Base command
CMD="pnpm prisma:studio"

# Add port if specified
if [ -n "$PORT" ]; then
  CMD="$CMD --port $PORT"
fi

# Add browser none if --no-browser
if [ "$NO_BROWSER" = "true" ]; then
  CMD="$CMD --browser none"
fi
```

### Step 3: Launch Studio

Run the command:

```bash
pnpm prisma:studio [options]
```

**Note:** Studio runs as a foreground process. The user will need to Ctrl+C to stop it.

## Output Format

```
🔍 Prisma Studio

Starting database explorer...

  Database: .data/dev.db (SQLite)
  URL: http://localhost:<port>

Studio is running. Press Ctrl+C to stop.
```

## Notes

- Studio requires the database to exist (run `pnpm prisma db push` first if needed)
- Default port is dynamically assigned if not specified
- The `--browser none` option is useful when:
  - Running on a remote server
  - You want to open the URL manually
  - Running in a CI/automated environment

## Database Location

The SQLite database is located at `.data/dev.db`. If the database doesn't exist:

```bash
pnpm prisma db push
```

## Supported Operations in Studio

- Browse all tables and records
- Add, edit, and delete records
- Filter and search data
- View relationships between tables
