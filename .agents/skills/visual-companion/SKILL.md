---
name: visual-companion
description: Browser-based visual companion for showing mockups, diagrams, comparisons, and interactive options. Use when the user would understand something better by seeing it than reading it.
license: Complete terms in LICENSE.txt
---

# Visual Companion

Browser-based visual companion for rendering mockups, diagrams, and interactive options. The server watches a directory for HTML files and serves the newest one to the browser. You write HTML content, the user sees it in their browser and can click to select options.

## When to Use

Decide per-question, not per-session. The test: **would the user understand this better by seeing it than reading it?**

**Use the browser** when the content itself is visual:

- **UI mockups** -- wireframes, layouts, navigation structures, component designs
- **Architecture diagrams** -- system components, data flow, relationship maps
- **Side-by-side visual comparisons** -- comparing two layouts, two color schemes, two design directions
- **Design polish** -- when the question is about look and feel, spacing, visual hierarchy
- **Spatial relationships** -- state machines, flowcharts, entity relationships rendered as diagrams

**Use the terminal** when the content is text or tabular:

- **Requirements and scope questions** -- "what does X mean?", "which features are in scope?"
- **Conceptual A/B/C choices** -- picking between approaches described in words
- **Tradeoff lists** -- pros/cons, comparison tables
- **Technical decisions** -- API design, data modeling, architectural approach selection
- **Clarifying questions** -- anything where the answer is words, not a visual preference

A question _about_ a UI topic is not automatically a visual question. "What kind of wizard do you want?" is conceptual -- use the terminal. "Which of these wizard layouts feels right?" is visual -- use the browser.

## How It Works

The server watches a directory for HTML files and serves the newest one to the browser. You write HTML content to `screen_dir`, the user sees it in their browser and can click to select options. Selections are recorded to `state_dir/events` as JSONL that you read on your next turn.

**Content fragments vs full documents:** If your HTML file starts with `<!DOCTYPE` or `<html`, the server serves it as-is (injecting the helper script). Otherwise, the server automatically wraps your content in the frame template -- adding the header, CSS theme, selection indicator, and all interactive infrastructure. **Write content fragments by default.** Only write full documents when you need complete control over the page.

## Starting a Session

```bash
# Start server with persistence (content saved to project)
scripts/start-server.sh --project-dir /path/to/project

# Returns JSON:
# {"type":"server-started","port":52341,"url":"http://localhost:52341",
#  "screen_dir":"/path/to/project/.dork/visual-companion/12345-1706000000/content",
#  "state_dir":"/path/to/project/.dork/visual-companion/12345-1706000000/state"}
```

Save `screen_dir` and `state_dir` from the response. Tell the user to open the URL.

**Finding connection info:** The server writes its startup JSON to `$STATE_DIR/server-info`. If you launched the server in the background and did not capture stdout, read that file to get the URL and port. When using `--project-dir`, check `<project>/.dork/visual-companion/` for the session directory.

**Note:** Pass the project root as `--project-dir` so content persists in `.dork/visual-companion/` and survives server restarts. Without it, files go to `/tmp` and get cleaned up. Remind the user to add `.dork/` to `.gitignore` if it is not already there.

### Launching (all platforms)

The server must outlive the Bash tool call that starts it. Use `--foreground` combined with `run_in_background: true` on the Bash tool so the process persists across conversation turns.

```bash
# CORRECT — server survives across turns
scripts/start-server.sh --project-dir /path/to/project --foreground
# Set run_in_background: true on the Bash tool call
```

Then on the next turn, find the newest session directory and read `$STATE_DIR/server-info` to get the URL and port:

```bash
# Find newest session
ls <project>/.dork/visual-companion/ | sort -t'-' -k2 -n | tail -1
# Read connection info
cat <project>/.dork/visual-companion/<session>/state/server-info
```

**Why not the default background mode?** The default mode (`start-server.sh` without `--foreground`) backgrounds the server as a child of the Bash process. When the Bash tool call completes, the parent shell exits and the server self-terminates with `"reason":"owner process exited"`. This happens on all platforms — macOS, Linux, and Windows.

If the URL is unreachable from your browser (common in remote/containerized setups), bind a non-loopback host:

```bash
scripts/start-server.sh \
  --project-dir /path/to/project \
  --host 0.0.0.0 \
  --url-host localhost
```

Use `--url-host` to control what hostname is printed in the returned URL JSON.

## The Content Loop

1. **Check server is alive**, then **write HTML** to a new file in `screen_dir`:
   - Before each write, check that `$STATE_DIR/server-info` exists. If it does not (or `$STATE_DIR/server-stopped` exists), the server has shut down -- restart it with `start-server.sh` before continuing. The server auto-exits after 30 minutes of inactivity.
   - Use semantic filenames: `platform.html`, `visual-style.html`, `layout.html`
   - **Never reuse filenames** -- each screen gets a fresh file
   - Use the Write tool -- **never use cat/heredoc** (dumps noise into terminal)
   - Server automatically serves the newest file

2. **Tell user what to expect and end your turn:**
   - Remind them of the URL (every step, not just first)
   - Give a brief text summary of what is on screen (e.g., "Showing 3 layout options for the homepage")
   - Ask them to respond in the terminal: "Take a look and let me know what you think. Click to select an option if you'd like."

3. **On your next turn** -- after the user responds in the terminal:
   - Read `$STATE_DIR/events` if it exists -- this contains the user's browser interactions (clicks, selections) as JSONL
   - Merge with the user's terminal text to get the full picture
   - The terminal message is the primary feedback; `state_dir/events` provides structured interaction data

4. **Iterate or advance** -- if feedback changes the current screen, write a new file (e.g., `layout-v2.html`). Only move to the next question when the current step is validated.

5. **Unload when returning to terminal** -- when the next step does not need the browser (e.g., a clarifying question, a tradeoff discussion), push a waiting screen to clear stale content:

   ```html
   <!-- filename: waiting.html (or waiting-2.html, etc.) -->
   <div style="display:flex;align-items:center;justify-content:center;min-height:60vh">
     <p class="subtitle">Continuing in terminal...</p>
   </div>
   ```

   This prevents the user from staring at a resolved choice while the conversation has moved on. When the next visual question comes up, push a new content file as usual.

6. Repeat until done.

## CSS Classes Available

The frame template provides these CSS classes for content fragments. No `<html>`, CSS, or `<script>` tags needed -- the server provides all of that.

### Options (A/B/C choices)

```html
<div class="options">
  <div class="option" data-choice="a" onclick="toggleSelect(this)">
    <div class="letter">A</div>
    <div class="content">
      <h3>Title</h3>
      <p>Description</p>
    </div>
  </div>
</div>
```

**Multi-select:** Add `data-multiselect` to the container to let users select multiple options. Each click toggles the item. The indicator bar shows the count.

```html
<div class="options" data-multiselect>
  <!-- same option markup -- users can select/deselect multiple -->
</div>
```

### Cards (visual designs)

```html
<div class="cards">
  <div class="card" data-choice="design1" onclick="toggleSelect(this)">
    <div class="card-image"><!-- mockup content --></div>
    <div class="card-body">
      <h3>Name</h3>
      <p>Description</p>
    </div>
  </div>
</div>
```

### Mockup container

```html
<div class="mockup">
  <div class="mockup-header">Preview: Dashboard Layout</div>
  <div class="mockup-body"><!-- your mockup HTML --></div>
</div>
```

### Split view (side-by-side)

```html
<div class="split">
  <div class="mockup"><!-- left --></div>
  <div class="mockup"><!-- right --></div>
</div>
```

### Pros/Cons

```html
<div class="pros-cons">
  <div class="pros">
    <h4>Pros</h4>
    <ul>
      <li>Benefit</li>
    </ul>
  </div>
  <div class="cons">
    <h4>Cons</h4>
    <ul>
      <li>Drawback</li>
    </ul>
  </div>
</div>
```

### Mock elements (wireframe building blocks)

```html
<div class="mock-nav">Logo | Home | About | Contact</div>
<div style="display: flex;">
  <div class="mock-sidebar">Navigation</div>
  <div class="mock-content">Main content area</div>
</div>
<button class="mock-button">Action Button</button>
<input class="mock-input" placeholder="Input field" />
<div class="placeholder">Placeholder area</div>
```

### Typography and sections

- `h2` -- page title
- `h3` -- section heading
- `.subtitle` -- secondary text below title
- `.section` -- content block with bottom margin
- `.label` -- small uppercase label text

## Browser Events Format (JSONL)

When the user clicks options in the browser, their interactions are recorded to `$STATE_DIR/events` as one JSON object per line. The file is cleared automatically when you push a new screen.

```jsonl
{"type":"click","choice":"a","text":"Option A - Simple Layout","timestamp":1706000101}
{"type":"click","choice":"c","text":"Option C - Complex Grid","timestamp":1706000108}
{"type":"click","choice":"b","text":"Option B - Hybrid","timestamp":1706000115}
```

The full event stream shows the user's exploration path -- they may click multiple options before settling. The last `choice` event is typically the final selection, but the pattern of clicks can reveal hesitation or preferences worth asking about.

If `$STATE_DIR/events` does not exist, the user did not interact with the browser -- use only their terminal text.

## Design Tips

- **Scale fidelity to the question** -- wireframes for layout, polish for polish questions
- **Explain the question on each page** -- "Which layout feels more professional?" not just "Pick one"
- **Iterate before advancing** -- if feedback changes current screen, write a new version
- **2-4 options max** per screen
- **Use real content when it matters** -- for a photography portfolio, use actual images (Unsplash). Placeholder content obscures design issues.
- **Keep mockups simple** -- focus on layout and structure, not pixel-perfect design

## File Naming

- Use semantic names: `platform.html`, `visual-style.html`, `layout.html`
- Never reuse filenames -- each screen must be a new file
- For iterations: append version suffix like `layout-v2.html`, `layout-v3.html`
- Server serves newest file by modification time

## Capturing Design Decisions for Specs

When using the visual companion alongside a feature spec (`specs/<slug>/`), capture the design work so implementing agents can consume it without reading raw HTML mockups.

### During the session

- Name screens to match the design question (e.g., `agent-channels-tab.html`, `settings-layout.html`)
- After each round of feedback, note the user's selections and verbal reasoning

### At session end

Write a `04-design-decisions.md` file into the spec directory that captures:

1. **Each design question explored** — what was asked, which screen file showed it
2. **Options presented** — brief description of each option (A, B, C)
3. **What was chosen and why** — the user's selection plus their reasoning
4. **Final design direction** — prose descriptions of the agreed-upon designs, detailed enough that an implementing agent can build from them without seeing the mockups

Example structure:

```markdown
# Design Decisions

Visual companion session: `.dork/visual-companion/<session-id>/`

## 1. [Design Question]

**Screen:** `<filename>.html`
**Options:** A) ... B) ... C) ...
**Chosen:** B — [reasoning from user]

## 2. [Next Design Question]

...

## Final Design Summary

[Prose description of the complete agreed design, suitable for implementation]
```

### Spec frontmatter

Add the session reference to the spec's ideation or specification frontmatter:

```yaml
design-session: .dork/visual-companion/<session-id>
```

This lets implementing agents find the raw HTML mockups if they need visual reference.

### When to skip

If the visual companion was used for a quick one-off question (not part of a spec), skip the design decisions file. This process only applies when the session is part of a spec workflow.

## Shutting Down

```bash
scripts/stop-server.sh $SESSION_DIR
```

If the session used `--project-dir`, content files persist in `.dork/visual-companion/` for later reference. Only `/tmp` sessions get deleted on stop.

## Reference

- Frame template (CSS reference): `scripts/frame-template.html`
- Helper script (client-side): `scripts/helper.js`
- Server implementation: `scripts/server.cjs`
- Start script: `scripts/start-server.sh`
- Stop script: `scripts/stop-server.sh`
