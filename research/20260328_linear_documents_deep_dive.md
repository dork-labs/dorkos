---
title: 'Linear Documents: Deep Dive — Capabilities, Limitations, and Automation Fit'
date: 2026-03-28
type: external-best-practices
status: active
tags: [linear, documents, mcp, graphql, api, templates, workflow-automation, instruction-storage]
searches_performed: 18
sources_count: 22
---

# Linear Documents: Deep Dive

## Research Summary

Linear Documents are a rich-text, collaborative documentation surface built into Linear projects and issues. They support Markdown-compatible editing, versioning, real-time collaboration, templates, and subscriptions. As of early 2026, the GraphQL API supports `documentCreate`, `documentUpdate`, and `documentDelete` mutations, and the MCP server exposes `get_document` and `list_documents` (read-only). Documents are scoped to a project, initiative, or issue — there is no top-level workspace document hierarchy or folder system. For automated workflow systems, they are a feasible but constrained template store: readable and writable via API, but lacking folder organization, standalone workspace-level scope, or rich programmatic search.

---

## Key Findings

### 1. What Linear Documents Are

Linear Documents are long-form rich text documents attached to either a **project**, an **initiative**, or an **issue**. They serve as specs, PRDs, runbooks, or knowledge artifacts co-located with the work they describe. They use the same Markdown-compatible editor as issue descriptions and comments.

- Created via the `Resources` section of a project overview, the `Resources` section of an issue, or the `…` menu inside an issue
- Keyboard shortcuts: `O` then `D` to open documents
- Support real-time collaborative editing with visible cursor indicators
- All changes auto-save and sync instantly

### 2. Association Model (Standalone vs. Tied)

**Documents are NOT standalone workspace-level objects.** Based on the GraphQL schema, a Document must be associated with at least one of:

- `projectId` — attached to a Project
- `initiativeId` — attached to an Initiative
- `issueId` — attached to an Issue

The domain model research (Feb 2026) confirmed `projectId: UUID (nullable)`, and the schema analysis from `_generated_documents.graphql` confirmed `initiativeId` and `issueId` as additional association fields. There is no concept of an "orphan" document that exists in a flat workspace-level document library independent of projects/initiatives/issues.

**Implication for instruction template storage:** Every document must live under a project, initiative, or issue. A common workaround is to create a dedicated "Templates" project or "Docs" initiative to house template documents without them being buried inside a real delivery project.

### 3. Content Format

Linear Documents use a **Prosemirror-based rich text editor** (internally using Yjs for real-time CRDT collaboration). The API exposes content in two ways:

- `content` — Markdown-compatible string (the primary API-facing representation)
- `contentData` — base64-encoded Yjs state (the collaborative backend format, used internally)

**Supported formatting:**

- Three heading levels (H1–H3)
- Bold, italic, strikethrough, underline, inline code
- Bulleted lists, numbered lists, checklists
- Blockquotes, code blocks (with syntax highlighting), Mermaid diagrams
- Tables, horizontal dividers, collapsible sections
- @mentions for users, issues, projects, documents
- Date mentions (`@tomorrow`, `@October 12th`)
- Embedded URLs (YouTube, Figma, Loom auto-embed)
- File attachments
- Emoji support

**Writing content via API:** The `documentCreate` mutation accepts a `content` field as a markdown string. Linear's developer docs confirm you can include markdown-formatted content when creating documents, comments, or issues programmatically. For collapsible sections, the syntax is `+++ [section title]` … `+++`.

**Reading content via API:** The `content` field returns the document as a markdown string. Additionally, Linear Docs pages (the public documentation) support an `accept: text/markdown` header to return page content as markdown, and you can append `.md` to a Docs URL for the same effect — but this applies to Linear's own documentation site, not to user-created Documents in the workspace API.

### 4. Organization — Folders and Categories

**Linear Documents have no folder system.** There is no concept of folders, categories, tags, or collections for organizing documents. Organization is purely by association:

- Documents under a Project appear in that project's Resources tab
- Documents under an Initiative appear in that initiative's overview
- Documents under an Issue appear in that issue's Resources section

Within a project, documents appear as a **flat list** ordered by creation/update time. There is no way to group or nest documents inside a project.

**Workaround patterns:**

- Use naming conventions (e.g., `[Template] PRD`, `[Spec] Authentication`)
- Use a dedicated project or initiative as a "document library"
- Use document titles and @-mentions to create a lightweight navigation layer

### 5. Size Limits

No officially documented size limit for Linear Documents was found in public documentation, developer docs, changelog entries, or community discussions. Linear does not publish a character or file-size ceiling for document content. Practical limits would be imposed by:

- Browser rendering performance for very long documents
- The Yjs collaborative state size for very large documents
- Linear's server-side storage policies (not documented publicly)

In practice, teams use Linear Documents for specs, PRDs, and runbooks of typical length (a few thousand to tens of thousands of characters) without reported issues.

### 6. Search and Programmatic Filtering

**UI Search:** Linear's global search retrieves issues, projects, AND documents across a workspace. In the command menu, typing `d` followed by a space focuses results on documents specifically. Search is full-text across document titles and content.

**GraphQL API Filtering:** The `documents` query supports filtering. Based on schema analysis of `_generated_documents.graphql`, confirmed filter dimensions include:

- `project` — filter by associated project
- `initiative` — filter by associated initiative
- `creator` — filter by document creator
- `createdAt` / `updatedAt` — date range filters

There is no confirmed `content` full-text filter on the `documents` GraphQL query (unlike the UI search). Title-based filtering is available via standard string comparators (`eq`, `contains`, `containsIgnoreCase`, etc.).

**MCP server:** `list_documents` supports filtering by project, initiative, creator, and date ranges. This is the highest-level programmatic access short of direct GraphQL queries.

### 7. Linking to Issues and Projects

Documents have native bi-directional linking:

- A document can be associated with a project via `projectId`, an initiative via `initiativeId`, or an issue via `issueId` (confirmed in the GraphQL schema)
- Within document content, you can @mention any issue, project, or document — these become clickable links
- Specific document sections can be deep-linked by copying their header anchor URL
- Documents appear in the `Resources` section of their parent issue or project
- Webhooks fire `create`, `update`, `remove` events for Documents (confirmed in domain model research)

### 8. Versioning and History

Linear Documents have **a version history system**:

- Users can "revert to previous versions through the menu"
- The March 12, 2026 changelog added "hover tooltips showing user names in multi-user version history"
- The system tracks "when the document was last edited and by whom"
- Version history is available in the document UI but is **not exposed via the GraphQL API** — there is no `documentHistory` query or version snapshot retrieval in the public API
- The Yjs/CRDT backend implies fine-grained change tracking internally, but this is not surfaced for external consumers

**Authorship fields on the Document type:** `creator` (User who created it) and `updatedBy` (User who last edited it), plus `createdAt`/`updatedAt` timestamps.

### 9. Team Scope vs. Workspace Scope

Documents in Linear follow a **workspace-scoped visibility model by default**:

- Any workspace member can view documents attached to non-private projects or issues
- Documents under **private teams** (Business/Enterprise plan) are restricted to team members only
- There is no document-level access control (no "share with specific people" setting like Notion/Google Docs)
- Visibility is entirely derived from the visibility of the parent entity (project or issue)

**Team-level vs. workspace-level summary:**

- If a document is attached to a public project → visible to all workspace members
- If attached to a private team's issue or project → visible only to members of that private team
- There is no "workspace document library" concept — all documents inherit the visibility of their parent

**Templates** are a partial exception: document templates are authored at workspace or team settings level and are available as template choices when creating new documents, but the templates themselves are stored in settings, not as accessible Document API entities.

### 10. MCP Tools for Documents

As of March 2026, the official Linear MCP server (`https://mcp.linear.app/mcp`) exposes the following document tools:

| Tool             | Description                                                                                    | Read/Write |
| ---------------- | ---------------------------------------------------------------------------------------------- | ---------- |
| `list_documents` | List documents in the workspace with filters for project, initiative, creator, and date ranges | Read       |
| `get_document`   | Retrieve a specific document by ID or slug                                                     | Read       |

**Not present in MCP (as of research date):**

- `create_document` — NOT available via MCP
- `update_document` — NOT available via MCP
- `delete_document` — NOT available via MCP

**Important nuance:** The February 5, 2026 changelog entry reads: "MCP Server: Added support for loading images and new tools for creating/updating documents in projects." However, independent analysis of the MCP tool inventory (from Fiberplane blog, OpenTools registry, and Jan.ai docs) consistently shows only `get_document` and `list_documents` as of the current research date. The changelog entry may refer to tools that have not yet been fully rolled out, or may apply to a specific tier/access level. The Fiberplane analysis explicitly notes "no `create_document` or `update_document` tools available" in a 23-tool inventory.

**Full MCP tool inventory (23 tools confirmed):**

- Issues: `list_issues`, `get_issue`, `create_issue`, `update_issue`, `list_comments`, `create_comment`, `get_issue_git_branch_name`, `list_my_issues`
- Issue config: `list_issue_statuses`, `get_issue_status`, `list_issue_labels`
- Projects: `list_projects`, `get_project`, `create_project`, `update_project`
- Teams/Users: `list_teams`, `get_team`, `list_users`, `get_user`
- Documents: `list_documents`, `get_document`
- Knowledge: `search_documentation`

**GraphQL API (full CRUD):** The underlying GraphQL API does expose `documentCreate`, `documentUpdate`, and `documentDelete` mutations, giving full programmatic control over documents outside the MCP layer.

### 11. Significant Limitations

1. **No standalone documents** — Every document must be attached to a project, initiative, or issue. No workspace-level document library.

2. **No folder/category system** — Documents within a project are a flat list. No nesting, tags, or grouping.

3. **No document-level permissions** — Access is entirely derived from the parent entity's visibility. No per-document ACL.

4. **Version history not in API** — Previous document versions cannot be retrieved programmatically; only available via the UI.

5. **MCP write operations absent (currently)** — `create_document` and `update_document` are not reliably available via MCP. Programmatic writes require direct GraphQL API calls.

6. **No full-text search in GraphQL filter** — The `documents` GraphQL query does not support content-based full-text search (only title/metadata filters). Full-text search is a UI feature only.

7. **No document-level templates in API** — Document templates are a UI/settings feature; they cannot be listed or applied programmatically via the API or MCP.

8. **Private document control requires paid plan** — Restricting document visibility requires private teams, which is a Business/Enterprise feature.

9. **Prosemirror state not portable** — The `contentData` (Yjs base64) format is opaque and not useful for external systems. Only `content` (markdown) is usable programmatically.

### 12. How Teams Use Linear Documents

Based on official docs, changelog entries, and community sources:

- **Specs and PRDs**: The primary use case — write a product spec or PRD inside a project, link it to relevant issues via @mentions
- **Technical runbooks and design docs**: Attach to engineering projects or epics as documentation artifacts
- **Status updates**: As an alternative to ProjectUpdates for more detailed narrative updates
- **Onboarding docs**: Create a dedicated onboarding project with documents as a lightweight wiki
- **Templates**: Use document templates (at workspace or team level) to standardize PRDs, retrospectives, RFC formats
- **Meeting notes / decision logs**: Attach to an issue representing a decision or meeting
- **Agent guidance**: Linear's own "Agent Guidance" feature (for Linear Agent) is stored in markdown editors in Settings — separate from the Documents system, though it shares the same editor component

---

## Detailed Analysis

### Document as Instruction Template Storage: Assessment

The research question asks whether Linear Documents would work well as **instruction template storage for an automated workflow system**. Here is a structured assessment:

**Strengths:**

1. **API-readable**: The `documents` GraphQL query and `get_document` MCP tool provide reliable programmatic read access. A workflow agent can query documents by project/initiative, retrieve their markdown content, and inject it as instructions.

2. **Markdown output**: The `content` field returns clean markdown, which is directly usable as LLM context without transformation.

3. **Human-editable**: Non-engineers can create and update instruction documents via Linear's polished UI, making templates maintainable by the whole team.

4. **Version history**: The UI provides versioning, so teams can audit changes to instruction templates over time.

5. **Contextual co-location**: Storing instruction templates inside the same Linear project they describe creates natural co-location — a "Deploy Instructions" document lives next to the issues it governs.

6. **Templates**: Linear's document template system allows standardized instruction starters.

7. **Webhook notifications**: Webhook events fire on document `create`, `update`, `remove` — an automation system can react when instruction templates are modified.

**Weaknesses:**

1. **No standalone documents**: Every instruction document must live under a project, initiative, or issue. For a general workspace-level instruction store, you would need to create a dedicated "Instructions" project or "Templates" initiative as a container, which is a workaround, not a first-class pattern.

2. **No folder organization**: A large instruction set (e.g., 50 templates for different agent workflows) would be a flat list inside a project. Navigation and discoverability become painful at scale.

3. **No MCP write operations (reliably)**: Automated systems that need to update or create instruction documents programmatically cannot do so via MCP — they must use the direct GraphQL API with a personal API key or OAuth token.

4. **No programmatic full-text search**: You can list documents by project/initiative and filter by metadata, but you cannot search document _content_ via the API. A system that needs to find the right template by content keywords would need to fetch all documents and search client-side.

5. **No document-level tags or categories**: Cannot tag a document as "type: instruction-template" vs. "type: spec". The only grouping mechanism is the parent entity (project/initiative).

6. **Visibility coupling**: If instruction templates should be visible to all workspace members but the project they live in is private, there's a conflict. You would need to keep the template container project public.

**Verdict:**

Linear Documents are a **feasible but not optimal** storage layer for instruction templates in an automated workflow system. They work well for:

- Small sets of project-scoped instructions (5–15 documents per project)
- Templates that benefit from human authoring in a polished editor
- Instructions that are contextually co-located with work in Linear

They are a poor fit for:

- Large, standalone template libraries (50+ templates needing folder organization)
- Instruction stores that require content-based programmatic search
- Systems where the automation must write/update templates via MCP (rather than GraphQL)
- Multi-tenant or permission-controlled instruction sets per user/team

**The best pattern** for using Linear Documents as instruction storage: Create a dedicated Linear Project (e.g., "Agent Instructions" or "Workflow Templates") with no issues, just documents. Use document titles with a clear naming convention (e.g., `[DEPLOY] Release checklist`, `[TRIAGE] Bug classification rules`). Query them via `list_documents` filtered by that project. Retrieve content via `get_document`. Update via direct GraphQL `documentUpdate` mutation.

---

## GraphQL Schema Summary

Based on schema analysis from `_generated_documents.graphql`:

**Document type fields (confirmed):**

```
id:             UUID
createdAt:      DateTime
updatedAt:      DateTime
archivedAt:     DateTime (nullable)
title:          String
content:        String (markdown)
contentData:    String (base64 Yjs state, for collaborative editing)
documentContentId: UUID (reference to DocumentContent entity)
slugId:         String (URL-friendly identifier)
icon:           String (nullable)
color:          String (nullable)
trashed:        Boolean (soft-delete flag)
projectId:      UUID (nullable, parent Project)
initiativeId:   UUID (nullable, parent Initiative)
issueId:        UUID (nullable, parent Issue)
creatorId:      UUID (User who created the document)
updatedBy:      User (User who last edited)
```

**Mutations available via GraphQL API:**

- `documentCreate(input: DocumentCreateInput!)` — create a new document
- `documentUpdate(id: UUID!, input: DocumentUpdateInput!)` — update title/content/icon/color/associations
- `documentDelete(id: UUID!)` — delete a document

**Query available:**

- `documents(filter: DocumentFilter, ...)` — list documents with pagination and filtering
- `document(id: UUID!)` — get a single document by ID

---

## Sources & Evidence

- "Documents use the same Markdown as issues and have similar editing capabilities" — [Project Documents – Linear Docs](https://linear.app/docs/project-documents)
- "Issue documents: Create documents when inside of an issue under the … menu > Add Document" — [Issue Documents – Linear Docs](https://linear.app/docs/issue-documents)
- "Documents retrieve issues, projects, and documents across your workspace" — [Search – Linear Docs](https://linear.app/docs/search)
- "Revert to previous versions through the menu" — [Project Documents – Linear Docs](https://linear.app/docs/project-documents)
- "All guidance is passed to the agent... authored in a markdown editor with full history" — [Agents in Linear – Linear Docs](https://linear.app/docs/agents-in-linear)
- MCP tools confirmed as `list_documents`, `get_document` (read-only) — [The Linear Team Made a Good MCP – Fiberplane Blog](https://blog.fiberplane.com/blog/mcp-server-analysis-linear/)
- "Added hover tooltips showing user names in multi-user version history" — [Linear Changelog, March 12, 2026](https://linear.app/changelog)
- "MCP Server: new tools for creating/updating documents in projects" — [Linear Changelog, February 5, 2026](https://linear.app/changelog)
- `documentCreate`, `documentUpdate`, `documentDelete` mutations — [Linear SDK Generated Documents GraphQL](https://github.com/linear/linear/blob/master/packages/sdk/src/_generated_documents.graphql)
- Document schema fields (`projectId`, `initiativeId`, `issueId`, `content`, `contentData`) — [Linear SDK Schema GraphQL](https://github.com/linear/linear/blob/master/packages/sdk/src/schema.graphql)
- MCP tool inventory (23 tools) — [Linear MCP Server – OpenTools Registry](https://opentools.com/registry/linear-remote)
- Document subscriptions changelog — [Document Subscriptions – Linear Changelog](https://linear.app/changelog/2024-10-10-document-subscriptions)
- Linear Agent and Guidance — [Introducing Linear Agent – Changelog](https://linear.app/changelog/2026-03-24-introducing-linear-agent)
- "Every Linear Docs page can now be copied as Markdown" — [Linear on X](https://x.com/linear/status/1944758116396024313)
- Document templates available at workspace/team settings level — [Project Documents – Linear Docs](https://linear.app/docs/project-documents)
- Editor capabilities (formatting options) — [Editor – Linear Docs](https://linear.app/docs/editor)
- Private teams feature (Business/Enterprise) — [Private Teams – Linear Docs](https://linear.app/docs/private-teams)

---

## Research Gaps & Limitations

1. **Exact MCP write-tool availability**: The Feb 5 changelog mentions `create_document`/`update_document` but current tool inventories show only read tools. This discrepancy was not fully resolved — the tools may be in staged rollout or require specific auth scopes.

2. **Document size limits**: No published limit found. Linear does not document a character or byte ceiling for document content.

3. **DocumentFilter full schema**: The exact filter fields available on the `documents` GraphQL query were inferred from MCP description and schema analysis, not from a complete official filter reference page.

4. **`contentData` format details**: The base64 Yjs state field format is confirmed to exist but the schema for decoding it was not documented.

5. **Document count limits per project/workspace**: No documented limit on how many documents a project can contain.

6. **Template API access**: Document templates (in Settings) do not appear to be accessible via the GraphQL API or MCP, only through the UI.

---

## Search Methodology

- Searches performed: 18
- Most productive search terms: "Linear docs project-documents site:linear.app", "linear mcp tools documents list_documents 2026", "\_generated_documents.graphql Linear", "Linear changelog documents 2025 2026"
- Most productive sources: linear.app/docs/project-documents, linear.app/docs/issue-documents, github.com/linear/linear schema files, blog.fiberplane.com MCP analysis, linear.app/changelog
