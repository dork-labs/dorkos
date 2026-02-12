---
description: Open the roadmap visualization in a browser
argument-hint: "(no arguments)"
allowed-tools: Bash
category: roadmap
---

# Roadmap Open

Open the roadmap visualization in your default browser. The roadmap is now integrated into the Next.js application.

## Usage

```
/roadmap:open
```

## Implementation

### Step 1: Check if Dev Server is Running

```bash
if lsof -i :3000 > /dev/null 2>&1; then
  echo "Dev server detected on port 3000"
else
  echo "Warning: Dev server may not be running on port 3000"
  echo "Start it with: pnpm dev"
  echo ""
fi
```

### Step 2: Open Browser

```bash
open "http://localhost:3000/roadmap"
```

### Step 3: Report to User

```bash
echo "Opening roadmap at http://localhost:3000/roadmap"
echo ""
echo "Features available:"
echo "  - Timeline View (Now/Next/Later)"
echo "  - Status View (by status)"
echo "  - Priority View (MoSCoW groups)"
echo "  - Health Dashboard"
echo "  - Filtering by type, priority, status"
echo "  - Item detail modals"
echo ""
echo "Related commands:"
echo "  /roadmap:show      - CLI text summary (no browser needed)"
echo "  /roadmap:add       - Add a new item"
echo "  /roadmap:validate  - Validate roadmap.json"
```

## Notes

- Requires the Next.js dev server to be running (`pnpm dev`)
- The roadmap is served from `/roadmap` route in the Next.js app
- For production, the roadmap is statically rendered at build time
- Python scripts still work for CLI management (`/roadmap:add`, `/roadmap:validate`, etc.)
