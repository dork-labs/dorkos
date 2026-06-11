# Triage Intake — Universal Input Classifier

This template is loaded when `/pm` receives freeform text (not `auto` or a `DOR-` ID).

## Input Parsing

1. If the input looks like a file path (starts with `/`, `./`, `~`, or ends with `.md`/`.txt`):
   - Read the file
   - Use file contents as the input text
   - Note the source file path for reference
2. Otherwise, treat the argument string as the input text

## Classification Rubric

Analyze the input and classify it into exactly one category:

| Category              | Signals                                                                                     | Action                                                |
| --------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Idea**              | Feature request, enhancement, "what if", "we should", suggestion                            | Create single `type/idea` issue                       |
| **Bug/Signal**        | Error report, regression, metric anomaly, "broken", "failing", stack trace                  | Create `type/signal` issue with priority 2 (High)     |
| **Research Question** | "How does X work", "What's the best way to", "Investigate", "Compare"                       | Create `type/research` issue                          |
| **Feedback**          | References existing issue (DOR-NNN), "regarding", "follow-up on", critique of existing work | Find related issue, add comment or create `type/meta` |
| **Brief**             | Multi-concern document, project-level scope, 3+ distinct deliverables/workstreams           | Decompose into project + multiple typed issues        |
| **Ambiguous**         | Cannot classify with confidence                                                             | Ask the user to clarify                               |

**Default**: If no strong signals match, classify as **Idea**. Ideas are the lowest-commitment entry point and can be re-classified during triage.

## Single-Issue Creation (Idea, Bug/Signal, Research, Feedback)

For single-issue classifications:

1. Create the issue via `save_issue`:
   - **team**: DorkOS (from config.json `team.id`)
   - **title**: Concise, actionable summary (imperative voice)
   - **description**: Full input text with any context. If from a file, include the source path.
   - **labels**: Appropriate `type/*` label + `origin/human`
   - **state**: Triage
   - **priority**: Bug/Signal → 2 (High). Research with clear urgency → 3 (Medium). Ideas → leave unset (priority comes at triage/commitment). See SKILL.md "Priority and Estimates".
   - **estimate**: Set if scope is already clear (Fibonacci; 1 ≈ single agent session). If estimating ≥ 5, note in the description that decomposition is needed. Leave unset when scope is unknown — triage sets it.
   - **project**: Bugs/tasks that clearly advance an existing project → assign it. Small standalone committed fixes → Maintenance project. Ideas/research → project-less is fine (orphan policy, SKILL.md "Orphan Issues").
2. If the description claims a dependency ("blocked by DOR-NNN"), create the Linear blocking relation — relations are what dispatch reads, prose is invisible.
3. Add a next-steps comment (per SKILL.md convention)
4. Report: issue ID, title, type, priority/estimate, what happens next

## Feedback on Existing Work

When the input references an existing issue:

1. Search for the issue: `list_issues(team: "dorkos", query: "<key terms or DOR-NNN>", includeArchived: false)`
2. If found:
   - Add a comment to the existing issue with the feedback
   - If the feedback suggests new work, create a related `type/meta` issue
3. If not found:
   - Create a `type/meta` issue with the feedback
   - Add a note that no related issue was found

## Multi-Concern Detection (Brief)

If the input contains 3+ distinct deliverables, workstreams, or concerns:

1. List the identified concerns (e.g., "I see 5 distinct workstreams: ...")
2. **Trigger `project-creation` approval gate** — present the decomposition plan:

   ```
   This looks like a project-level brief with N concerns:
   1. [Concern 1] → type/idea
   2. [Concern 2] → type/research
   3. [Concern 3] → type/hypothesis
   ...

   Recommended: Create a Linear project "[Project Name]" with these as child issues.
   This requires approval (project-creation gate).

   Approve? (Y/N)
   ```

3. On approval:
   - Create the Linear project
   - Create individual issues for each concern with appropriate type labels
   - Link all issues to the project
   - Each issue gets `origin/human` label
   - Add a next-steps comment to each issue
4. Report: project name, all created issue IDs and types

## Post-Creation

After creating any issue(s):

- Add a next-steps comment per SKILL.md convention:
  ```
  **Agent Action** — [YYYY-MM-DD]
  **Action:** Created from intake classification ([type])
  **Reasoning:** [brief classification rationale]
  **Next steps:** Awaiting triage via /pm
  ```
- Report to the user: issue ID(s), title(s), type(s), project assignment (if any)
