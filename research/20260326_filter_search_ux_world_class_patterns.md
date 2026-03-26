---
title: 'World-Class Filter & Search UX Patterns — Linear, Notion, GitHub, Apple, and Composable Systems'
date: 2026-03-26
type: external-best-practices
status: active
tags:
  [
    filter-ux,
    search-ux,
    filter-chips,
    filter-bar,
    faceted-search,
    url-state,
    command-palette,
    empty-state,
    linear,
    notion,
    github,
    apple,
    developer-tools,
  ]
searches_performed: 18
sources_count: 34
---

# World-Class Filter & Search UX Patterns

## Research Summary

This report synthesizes research across five world-class products (Linear, Notion, GitHub, Apple's native apps) and core UX literature to extract actionable filter and search UX patterns for developer tools. The central finding: the best filter systems are **invisible when inactive and instant when engaged** — they live in the background, surface on demand via keyboard, compose logically, persist as sharable URLs and named views, and degrade gracefully into helpful guidance when they produce no results. The right choice of pattern depends on dataset size and user expertise level.

---

## Key Findings

### 1. Linear: The Gold Standard for Developer Tool Filtering

Linear's filter system is the most copied in developer tools because it nails all four axes simultaneously: discoverability (keyboard shortcut `F`), expressiveness (AND/OR with nested groups), persistence (temporary filters save to durable Views), and restraint (the filter bar disappears when inactive).

### 2. Notion: Structural Filter Builder for Complex Schemas

Notion uses a modal/popover filter builder — property → condition → value — that is ideal when the filterable schema is user-defined and dynamic. It trades immediacy for expressiveness, appropriate for knowledge management where users define their own data structure.

### 3. GitHub: Text Syntax as Filter, UI as Sugar

GitHub treats the search bar as the filter bar. Structured qualifiers (`assignee:@me label:bug`) compose naturally with full text search, and the UI is sugar on top of syntax. This pattern scales to millions of items because the filter is a query, not a form.

### 4. Apple: Token-Based Filtering, Scope Restriction, Smart Folders

Apple's native apps treat filter tokens as first-class interactive objects in the search field — visual pills that encode structured criteria while remaining draggable and removable. The scope bar restricts where search applies. Smart Folders persist filters as named collections. The philosophy is progressive disclosure: type text first, add tokens as needed.

### 5. Composable Filter Systems: Seven Patterns That Matter

The best developer tool filter systems combine: instant inline text filtering, status/tag chips, URL-synced state, keyboard-first activation, smart empty states, filter-to-view promotion, and logical AND/OR composition.

---

## Detailed Analysis

### Linear's Filter System

#### Entry Points and Keyboard-First Design

Linear opens filters with the `F` key — no modifier, single character, immediately memorable. Pressing `F` again adds a second filter. This places filtering on the same level as navigation shortcuts (`G` for go, `C` for create, `F` for filter). The filter menu shows all available filter types alongside the count of matching issues for each option, enabling informed filter selection before committing.

**Why this works**: Power users running 10+ agents (Kai's archetype) don't want to reach for a mouse. A single keypress that surfaces a searchable filter picker is the correct mental model for a control panel, not a consumer app.

#### Filter Chips in the UI

Once applied, each filter appears as a removable chip in the header bar. Chips encode three elements: the property name (e.g., "Assignee"), the operator (e.g., "is"), and the value (e.g., "Kai"). Clicking any part of the chip re-opens the filter editor for that condition. Clicking the X removes that single filter.

**Chip anatomy** (property | operator | value):

```
[Assignee: is Kai ×]  [Priority: is High ×]
```

The chips are interactive — not just display. Clicking "is" flips it to "is not." This creates a grammar of composable conditions without requiring the user to re-open a dialog.

#### AND/OR Toggle

When two or more filters are active, a toggle appears allowing "any filters" vs "all filters." This covers 90% of real-world logic needs without exposing the full complexity of nested boolean expressions to every user. Advanced users can access nested AND/OR groups for complex multi-condition queries.

**Default behavior**: AND. All active conditions must match. This is the correct default — it narrows results, which is what filtering is for.

#### No Filters vs. Active Filters State

When zero filters are active:

- The filter bar shows only the "Filter" button (ghost/secondary appearance)
- No visual weight in the header
- The view label reflects the current scope ("All Issues" or a team name)

When filters are active:

- The filter button gains a filled/accent state with a count badge
- Filter chips appear inline
- A "Clear filters" affordance appears
- The view label may show "[n] filters active" in secondary text

This contrast is critical: the header must communicate filter state at a glance without the user reading each chip individually.

#### Filter Persistence: Temporary vs. Durable Views

Linear makes a deliberate distinction between **temporary filters** (disappear on navigation) and **custom views** (permanent, shareable, notification-capable). Once at least one filter is applied, a "Save view" button appears (also via `Option+V`). This promotes temporary exploration into a reusable artifact.

**Custom views** live in the sidebar, can trigger Slack/email notifications, can be favorited to the nav rail, and have stable URLs for sharing. They are the answer to "I always filter to my active issues assigned to me" — instead of re-filtering every session, you create a view once.

**The insight**: filter persistence is not about remembering your last filter state. It's about promoting frequently-used filter combinations into named, shareable, subscribable collections.

#### Available Filter Dimensions

Linear supports filtering across: Status, Assignee, Creator, Priority, Label, Estimate, Cycle, Project, Project Status, Relation types (blocked by, blocking, parent, duplicate), Dates (created, updated, due, completed), and Content (full-text). Operators adapt to each type — "is/is not" for enums, "includes any/all/none" for multi-select, "before/after" for dates.

---

### Notion's Filter Builder

#### Property → Condition → Value Pattern

Notion's filter UX follows a three-step builder: select the property to filter on, select the condition operator, enter the value. This pattern appears as a popover triggered by clicking "Add a filter" in the database view controls.

```
Property: [Status ▾]  Condition: [is ▾]  Value: [In Progress ▾]
```

This structured approach is appropriate for Notion because the database schema is user-defined — Notion cannot know in advance which properties exist or what types they are. The builder must be generic.

#### Filter Groups and AND/OR Logic

Filters are organized into groups. Within a group, conditions combine with AND. Between groups, conditions combine with OR. This enables complex expressions:

```
(Status = In Progress AND Assignee = Kai)
OR
(Status = Review AND Priority = High)
```

Filter groups appear as visually distinct blocks with a connector label ("And"/"Or") between them. Users add groups with "Add filter group" and switch the connector with a toggle.

#### Per-View Persistence

Filters in Notion persist per database view. A database can have multiple views (Table, Board, Calendar, Gallery, List, Timeline) each with independent filter configurations. This is powerful: one database can show "All tasks" in a table, "My active tasks" in a calendar, and "Blocked tasks" in a list — all from one data set with per-view filters.

#### Minimal Visual Footprint

When filters are active, Notion shows a small "Filtered" badge near the view controls with a count of active conditions. The full filter panel collapses by default — you see only the badge, not all the chips. This is notably more restrained than Linear's always-visible chips, appropriate for Notion's document-centric context where the data table is one element among many on a page.

**The trade-off**: Notion's filter visibility is lower than Linear's. For database power users, this means filters can be "forgotten" — you see filtered results without a clear reminder that filters are active. Linear's persistent chips prevent this.

---

### GitHub's Filter System

#### Search Bar as Filter Bar

GitHub issues use a single search/filter input that accepts both free text and structured qualifiers. The model is: everything is a search, and structured filters are special search syntax.

```
is:issue is:open assignee:@me label:bug -label:wontfix
```

This unifies search and filter into one mental model. There is no separate "Filters" UI — the search box IS the filter bar. Autocomplete suggests qualifiers as you type (`is:`, `assignee:`, `label:`), so users don't need to memorize syntax.

#### Qualifier Grammar

Key qualifiers:

- `is:open` / `is:closed` — state
- `is:issue` / `is:pr` — type
- `assignee:@me` / `assignee:username` — assignment
- `label:bug` / `label:"in progress"` — labels (quotes for multi-word)
- `author:username` — creation
- `-qualifier` — negation (exclude)
- Parentheses and `AND`/`OR` for boolean grouping

#### Boolean Operators and Nested Queries

GitHub rebuilt their search engine to support nested queries:

```
is:issue state:open author:rileybroughten (type:Bug OR type:Epic)
```

The UI highlights AND/OR keywords in the input and provides autocomplete for nested expressions. They enforced a nesting limit of five levels based on user research — beyond that, complexity outweighs value.

**Backward compatibility**: All existing bookmark and shared URLs (without explicit boolean operators) continue to work. This is a critical constraint for any filter system used at scale.

#### Saved Searches / Bookmarked Filters

GitHub doesn't have a formal "saved filters" concept at the repository level, but:

- Filtered URLs are fully shareable and bookmarkable (URL-synced state)
- GitHub Projects (the newer Projects v2) allows saved filter views
- Browser bookmarks serve as ad-hoc saved filters for power users

The absence of explicit saved filter UI is a gap GitHub has addressed only in Projects, not in the legacy Issues interface. Linear's Custom Views solve this more elegantly.

---

### Apple's Approach

#### Search Tokens: Filters as Interactive Chips in the Input Field

Apple's Human Interface Guidelines define **search tokens** as visual pills within the search field that represent structured filter criteria. Unlike Linear's chips in the header bar, Apple places tokens inside the search input itself — they coexist with free-text search.

In Finder, typing in the search box then clicking the "Name" button converts the text to a token:

```
[ 🔍 [kind: PDF ×] quarterly report ]
```

The token (PDF type filter) and free text ("quarterly report") compose into a combined filter. Tokens are:

- Draggable and copyable without text selection
- Removable with Delete key or click-to-dismiss
- Activatable by typing a trigger character (SwiftUI uses `#` by convention)

In macOS apps using `NSSearchField` and `NSTokenField`, tokens can be suggested as the user types, surfacing common filter combinations as autocomplete.

#### Scope Bar: Restricting Where Search Applies

The Finder scope bar appears below the search box and restricts which locations are searched:

```
[This Mac] [Macintosh HD] [Downloads] [Desktop]
```

This is the "where" dimension of filtering — separate from the "what" dimension (tokens). Scope bars answer: are we filtering all agents, or just agents in this namespace?

#### Filter Row: Progressive Attribute Criteria

When Finder results appear, clicking the `+` button in the filter bar adds a **filter row** — a rule specifying an attribute, condition, and value:

```
[Kind ▾] [is ▾] [PDF Document ▾]    [+] [-]
```

Multiple filter rows stack vertically and implicitly AND together. Users add rows with `+` and remove with `-`. This is Apple's version of Notion's filter builder, but always visible in context rather than in a popover.

#### Smart Folders: Saved Filters as Collections

Finder's Smart Folders save filter configurations as durable collections that auto-populate based on criteria. Mail's Smart Mailboxes follow the same pattern. These are the equivalent of Linear's Custom Views — named, persistent, auto-updating collections driven by saved filter criteria.

**The Apple design philosophy for filtering**:

- Progressive disclosure: start with text, add tokens, add filter rows
- Everything composes (text + tokens + scope + filter rows all work together)
- Persistence is a promotion (Smart Folder = saved filter rules)
- The search field is the primary entry point for all filtering

---

### Composable Filter Systems: Seven Core Patterns

#### Pattern 1: Instant Inline Text Filter

The baseline for small datasets (5–100 items). A text input that client-side filters the visible list in real time, zero network round-trips, zero debounce needed.

**Implementation**: `items.filter(item => item.name.toLowerCase().includes(query.toLowerCase()))`

**When to use**: Any list under ~200 items where data is already client-side.

**Pros**: Zero latency, no loading state needed, trivially implemented, instant feedback.

**Cons**: Does not scale to server-side data; requires all data to be loaded.

**Threshold**: NNGroup research suggests instant client-side filtering is superior to debounced API calls for lists under 100 items. Above that, consider server search.

#### Pattern 2: Status/Tag Chips Above the List

Predefined filter values shown as clickable chip/pill buttons above the list. A multi-select version allows combining chips; a single-select version acts as a tab bar.

```
[All] [Active ●] [Inactive] [Stale]
```

**Pros**: Zero cognitive overhead — users see all options immediately. One-click activation. No menu navigation required.

**Cons**: Space-constrained (max ~5-6 chips before it wraps or collapses). Not composable with complex AND/OR logic.

**Best used for**: Status, priority, environment — dimensions with 3-6 discrete values that matter to every user.

**Design principle**: The "All" chip should reset to zero filters, not select everything explicitly. Use a count badge on non-"All" chips to show matching items: `[Active (4)]`.

#### Pattern 3: Filter Chips as Interactive Grammar (Linear Pattern)

Applied filters appear as editable chips in the header. Each chip is a three-part grammar: property + operator + value. The operator is clickable to toggle (e.g., "is" → "is not").

```
[Status: is Active ×]  [Namespace: is myproject ×]  [Add filter +]
```

**Pros**: Highly expressive. Shows all active conditions at a glance. Composable — any number of chips. Operator editing without re-opening the picker.

**Cons**: More visual weight than Notion's badge approach. Requires a filter picker UI to add conditions.

**Best used for**: Primary developer tool list views where filters are the main workflow tool.

#### Pattern 4: Faceted Search (Algolia Pattern)

Sidebar or horizontal bar shows all filter dimensions with counts for each value:

```
Status          Priority
● Active (4)    ▪ High (2)
○ Inactive (2)  ▪ Medium (3)
○ Stale (1)     ▪ Low (2)
```

Clicking a facet value instantly filters the list. Clicking a second value in the same dimension ORs them. Clicking a value in a different dimension ANDs them.

**Pros**: Makes filter options discoverable without a picker. The counts prevent users from applying a filter that produces zero results.

**Cons**: Space-intensive (sidebar). Not appropriate for very small datasets. Counts must update dynamically (potentially expensive).

**Best used for**: Product catalogs, large issue lists, content libraries — anything with many filter dimensions and many items.

**Key design rule**: Never show a filter value whose count would be zero after selection. Greying out or hiding zero-count facets prevents the "no results" frustration.

#### Pattern 5: URL-Synced Filter State

Filter state lives in URL query parameters, not component state. The URL is the single source of truth.

```
/agents?status=active&namespace=myproject&q=claude
```

**Technology choices**:

- **TanStack Router** (already in use in DorkOS): Built-in type-safe search params with Zod validation at the route definition. Schema-first, compiler-enforced.
- **nuqs**: `useState`-like API that syncs to URL. Supports TanStack Router adapter. Adds debouncing for high-frequency inputs (search queries).

**Benefits**:

- Shareable filtered views — paste URL to share exact filter state
- Browser back/forward navigates through filter history
- Page refresh preserves filters (no lost state)
- Bookmarkable filter combinations

**Implementation principle** (TanStack Router pattern):

```ts
validateSearch: z.object({
  q: z.string().optional(),
  status: z.enum(['all', 'active', 'inactive', 'stale']).default('all'),
  namespace: z.string().optional(),
});
```

**Atomic updates**: Always use reducer-style partial updates (`search: prev => ({ ...prev, status: 'active' })`) to avoid clobbering other filter params.

**Pros**: Free persistence, shareability, browser integration, SSR-compatible.

**Cons**: URL length limits for very complex filter states. Filter values must be serializable to strings.

#### Pattern 6: Command-Palette Style Filter Input (The Hybrid)

Instead of a separate filter UI, the command palette (`⌘K`) doubles as a filter entry point. Typing in the palette enters "filter mode" — results are scoped to the current list. Pressing Enter applies the filter as a chip and closes the palette.

This is the pattern used in tools like Raycast, where the entire UI is "just a command bar."

**Pros**: Zero extra UI surface. Power users already live in the command palette. Works without learning a new UI pattern.

**Cons**: Discovery is low — users must know to type filter terms in the palette. Better as a secondary path than the primary.

**DorkOS relevance**: The existing command palette should understand filter intent. Typing "filter by active" or "show active agents" in `⌘K` should apply the appropriate filter to the current view and land the user on the agents page with that filter active.

#### Pattern 7: Filter-to-View Promotion (Linear Custom Views Pattern)

The "save as view" affordance promotes temporary filter combinations into permanent, named, shareable views. This is the answer to "I always use these filters."

**The flow**:

1. User applies filters to find what they want
2. After multiple uses, they notice the "Save as view" button (appears when ≥1 filter is active)
3. They name the view ("My Active Agents")
4. The view appears in the sidebar
5. The view can be shared as a URL, subscribed to for notifications, favorited

**Implementation considerations**:

- Views are server-persisted (user preference, not URL state)
- Views can be team-scoped or user-scoped
- A view is semantically: `{ name: string, filters: FilterConfig[], owner: UserId, scope: 'team' | 'personal' }`

---

## Empty State Design: Two Distinct Cases

### Case 1: True Empty State (No Data Exists)

When no agents are registered (or no sessions exist, etc.), the UI should be a **first-use moment**, not a blank screen.

**What to show**:

- A meaningful illustration or icon (not a generic empty box)
- Copy that explains the situation without jargon ("No agents registered yet")
- A primary action button that resolves the emptiness ("Register your first agent" → opens agent dialog)
- Optionally, a link to documentation

**Copy principle**: The message should reassure the user that nothing is broken and that this state is expected. "Your agent fleet is empty" with a "Register Agent" button is correct. A blank white area is not.

### Case 2: Filtered Empty State (Filters Produce No Matches)

When filters are active and nothing matches, the UI must help the user recover.

**What to show**:

- A clear "no results" message that names the active filters: "No agents match 'active' + 'myproject'"
- The active filter chips must remain visible (do not hide them)
- Three recovery paths in priority order:
  1. "Clear filters" button (primary action) — instant recovery
  2. Modification suggestion: "Try removing the namespace filter" (if one filter is clearly restrictive)
  3. "Register a new agent" if the filtered dimension maps to a creatable entity

**What NOT to show**: A generic "nothing here" message that doesn't acknowledge the filter state. If the user applied filters and sees an empty state, they must know it's because of filters, not because the product is broken.

**Visual distinction**: Use a different empty state illustration/copy for filtered vs. unfiltered empty state. Linear uses "No issues match your filters" vs. "Your team has no issues." The distinction matters.

**Intelligent filter prevention**: The gold standard is preventing zero-result states before they happen. Disable or grey-out filter values that would produce zero results (the Algolia/faceted search approach). This requires knowing item counts per filter value in advance — feasible for client-side data, requires server support for server-side data.

---

## Pros and Cons Summary

| Pattern                  | Pros                                       | Cons                                      | Best For                        |
| ------------------------ | ------------------------------------------ | ----------------------------------------- | ------------------------------- |
| Instant text filter      | Zero latency, trivial                      | Client-side only, no structure            | Any small list                  |
| Status chips             | Discoverable, one-click                    | Limited to 3-6 values, no composition     | Status/priority filtering       |
| Filter chips (Linear)    | Expressive, always visible                 | More UI surface, requires picker          | Developer tool primary views    |
| Faceted search           | Discoverable counts, prevents empty states | Space-intensive, requires count infra     | Large catalogs                  |
| URL-synced state         | Shareable, persistent, browser-native      | Values must be strings, URL length limits | All filters                     |
| Command palette filter   | Zero extra UI                              | Low discoverability, secondary path       | Power user shortcut             |
| Filter-to-view promotion | Permanent, shareable, subscribable         | Requires server persistence               | Frequently-reused filter combos |

---

## Design Principles Distilled

**1. The filter bar is ambient, not prominent.**
When no filters are active, the filter surface should have minimal visual weight — a ghost button, a search icon, nothing more. Active filters earn visual presence.

**2. Every applied filter must be visible and removable in one click.**
Never hide active filters. The user must always be able to see exactly what is affecting their view and remove any condition instantly.

**3. AND is the right default. OR is the escape valve.**
Multiple conditions should AND by default (narrow the results). Provide an AND/OR toggle for users who need to broaden. Never force users to think about logic before applying their first filter.

**4. URL is the right persistence layer for filter state.**
Filters should survive page refresh, browser back/forward, and being shared in a Slack message. URL query parameters deliver all of this for free.

**5. Filtered empty state and true empty state require different responses.**
A filtered empty state needs recovery (clear filters). A true empty state needs education (how to add the first item). Conflating them confuses users.

**6. Filters that would produce zero results should be visually suppressed.**
Show counts alongside filter options. Grey out or remove options that produce zero matches. Never let a user click themselves into an empty state without warning.

**7. Filter persistence as promotion, not default.**
Don't automatically remember the user's last filter state (this surprises them on next visit). Instead, provide explicit "save as view" to promote filters the user wants to keep.

**8. Keyboard first.**
A single keypress should open the filter UI. `F` (Linear), `/` (command palette), or a similar single-character shortcut. Mouse-only filter systems are a second-class experience for developer tools.

---

## Applicability to DorkOS

Given DorkOS targets Kai (10-20 agents, developer mindset) and Priya (flow-preservation, minimal distraction):

**Recommended pattern stack for the Agents page** (building on prior research):

1. **Instant text filter** — always visible, small input, client-side filtering by name/description
2. **Status chip row** — [All] [Active] [Inactive] [Stale] with count badges
3. **URL-synced state** — via TanStack Router `validateSearch` with Zod; already in the stack
4. **Filtered empty state** — distinct copy from true empty state; "Clear filters" primary action
5. **Command palette integration** — "filter by active" in `⌘K` applies the status chip and navigates to Agents

**Not yet warranted**:

- Full filter chips grammar (Linear pattern) — overkill for 5-50 agents with simple filter dimensions
- Faceted search sidebar — dataset too small; chips are sufficient
- Filter-to-view promotion — valid future addition once agents page matures and users have established workflows

The existing research (`20260320_agents_page_ux_patterns.md`, `20260322_agents_page_fleet_management_ux_deep_dive.md`) is consistent with these recommendations and goes deeper on fleet-management-specific patterns.

---

## Research Gaps & Limitations

- Notion's detailed filter builder interaction flow could not be fully extracted from documentation (requires JavaScript to render)
- Apple HIG pages require JavaScript to load; token field behavior was inferred from SwiftUI developer tutorials and developer API docs
- Linear's actual visual design specifics (chip colors, typography, spacing) were not accessible without live product access
- GitHub's saved filter UX for the legacy Issues interface (not Projects v2) is notably weaker than Linear — this gap is well-documented but solutions were not found

## Contradictions & Disputes

- **Filter persistence as default vs. explicit**: Some systems (Gmail, Spotify) remember your last filter/search state on return. Others (Linear, most developer tools) do not. The split seems to follow usage pattern — tools used multiple times per hour (Gmail) benefit from state memory; tools where context changes between sessions (project management) benefit from explicit save.
- **Chips inside vs. outside the search box**: Apple puts filter tokens inside the search input. Linear puts filter chips in the header bar. Both are valid; the choice depends on whether search text and filter tokens are conceptually unified (Apple) or separate concerns (Linear).

---

## Sources & Evidence

- [Filters – Linear Docs](https://linear.app/docs/filters) — comprehensive filter system documentation
- [Custom Views – Linear Docs](https://linear.app/docs/custom-views) — how filters promote to durable views
- [How we redesigned the Linear UI – Linear Blog](https://linear.app/now/how-we-redesigned-the-linear-ui) — design philosophy
- [Filter UX Design Patterns & Best Practices – Pencil & Paper](https://www.pencilandpaper.io/articles/ux-pattern-analysis-enterprise-filtering) — anatomy of filters, patterns
- [Empty State UX – Pencil & Paper](https://www.pencilandpaper.io/articles/empty-states) — filtered vs. true empty state distinction
- [19+ Filter UI Examples for SaaS – Eleken](https://www.eleken.co/blog-posts/filter-ux-and-ui-for-saas) — Linear, Intercom, Airtable examples
- [Search Filters: 5 Best Practices – Algolia](https://www.algolia.com/blog/ux/search-filter-ux-best-practices) — faceted search, dynamic counts
- [GitHub Issues Search: Nested Queries – GitHub Blog](https://github.blog/developer-skills/application-development/github-issues-search-now-supports-nested-queries-and-boolean-operators-heres-how-we-rebuilt-it/) — boolean operators, autocomplete
- [Filtering and Searching Issues – GitHub Docs](https://docs.github.com/en/issues/tracking-your-work-with-issues/using-issues/filtering-and-searching-issues-and-pull-requests) — qualifier grammar
- [Search Params Are State – TanStack Blog](https://tanstack.com/blog/search-params-are-state) — URL as filter state
- [Search Params Guide – TanStack Router](https://tanstack.com/router/v1/docs/framework/react/guide/search-params) — Zod validation at route
- [nuqs – Type-safe search params](https://nuqs.dev) — useState-like URL sync
- [Command K Bars – Maggie Appleton](https://maggieappleton.com/command-bar) — command palette as filter surface
- [Search Tokens – Hacking with Swift](https://www.hackingwithswift.com/quick-start/swiftui/how-to-add-search-tokens-to-a-search-field) — Apple token field pattern
- [UISearchToken – Apple Developer](https://developer.apple.com/documentation/uikit/uisearchtoken) — Apple's token API
- [Token Fields – Apple HIG](https://developer.apple.com/design/human-interface-guidelines/components/navigation-and-search/token-fields/) — token field design guidelines
- [Helpful Filter Categories – NN/g](https://www.nngroup.com/articles/filter-categories-values/) — filter design research
- [Views, Filters and Sorts – Notion Help](https://www.notion.com/help/views-filters-and-sorts) — Notion's filter system

## Search Methodology

- Searches performed: 18
- Most productive terms: "Linear filter docs", "GitHub issues boolean operators nested queries", "pencil paper enterprise filtering UX patterns", "search params are state TanStack", "Apple search token HIG SwiftUI"
- Primary sources: Official product documentation (Linear, GitHub, Notion, Apple), UX research publications (Pencil & Paper, NN/g, Algolia), engineering blog posts (GitHub Blog, TanStack Blog)
