---
description: Display the current roadmap summary in the terminal
argument-hint: "(no arguments)"
allowed-tools: Bash
category: roadmap
---

# Roadmap Show

Display a text-based roadmap summary directly in the terminal. Useful when you need a quick overview without opening a browser.

## Usage

```
/roadmap:show
```

## When to Use

- Quick CLI view without leaving the terminal
- When the dev server isn't running
- In CI/CD pipelines or scripts
- When you just need stats, not the full visualization

**For the full visual experience**, use `/roadmap:open` to view the interactive roadmap at `http://localhost:3000/roadmap`.

## Implementation

Run the generate_summary.py script and display the output:

```bash
python3 .claude/skills/managing-roadmap-moscow/scripts/generate_summary.py
```

## Output

The summary includes:
- Items grouped by time horizon (Now, Next, Later)
- Sub-grouped by MoSCoW priority (Must-Have, Should-Have, Could-Have, Won't-Have)
- Status indicators (not-started, in-progress, completed, on-hold)
- Health indicators (at-risk, blocked items)
- Statistics (total items, must-have %, in-progress count, at-risk count)

## Example Output

```
# Next.js Boilerplate

A production-ready Next.js 16 boilerplate...

Last Updated: 2026-02-01T12:00:00.000000+00:00

## Now (Current Sprint)

### Must Have

- **User Authentication** [Completed] [On Track] (8 pts)
  Implement passwordless authentication with BetterAuth...

### Should Have

- **Dashboard Layout** [In Progress] [On Track] (5 pts)
  Create a responsive dashboard layout...

## Statistics

- Total Items: 8
- Must-Have %: 37.5%
- In Progress: 1
- At Risk: 2
```

## Related Commands

| Command | Purpose |
|---------|---------|
| `/roadmap:open` | Open visual roadmap in browser |
| `/roadmap:analyze` | Detailed health analysis with recommendations |
| `/roadmap:validate` | Validate roadmap.json structure |
