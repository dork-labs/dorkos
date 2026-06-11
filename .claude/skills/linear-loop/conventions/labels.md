# Linear Loop Label Taxonomy

Labels are team-wide in the DorkOS Linear team. They use Linear's label group feature for organization.

## Issue Types (group: `type`)

| Label        | Color  | Description                                                | When to Use                                    |
| ------------ | ------ | ---------------------------------------------------------- | ---------------------------------------------- |
| `idea`       | purple | Raw idea, needs evaluation                                 | Someone has an idea — human or agent           |
| `research`   | blue   | Research task with structured output                       | Need to investigate before committing to build |
| `hypothesis` | yellow | Validated hypothesis with confidence + validation criteria | Research supports an opportunity worth testing |
| `task`       | indigo | Concrete implementation task                               | Single-session, actionable work                |
| `monitor`    | teal   | Outcome monitoring                                         | Watching validation criteria after shipping    |
| `signal`     | red    | Incoming external signal                                   | Error spike, metric drop, user feedback        |
| `meta`       | gray   | System improvement                                         | Improving instructions, templates, processes   |

**Mutually exclusive** — an issue has exactly one type label.

## Agent State (group: `agent`)

| Label         | Color  | Description                                      |
| ------------- | ------ | ------------------------------------------------ |
| `ready`       | green  | Ready for automated agent pickup                 |
| `claimed`     | yellow | Agent has claimed and is working on it           |
| `completed`   | indigo | Agent completed, awaiting review/validation      |
| `needs-input` | orange | Blocked on human input — agent posted a question |

### `needs-input` Protocol

When an agent encounters ambiguity during `/pm auto`:

1. Agent posts a structured comment on the issue with the question (multiple choice when possible)
2. Agent adds `needs-input` label
3. Agent assigns the issue to the authenticated user (triggers Linear notification)
4. Agent skips this issue and continues to next action

On next `/pm` run, the agent checks `needs-input` issues for human responses:

- If a new comment exists after the agent's question: remove label, set assignee to null, process answer
- If no response yet: show in dashboard as "Awaiting Your Input"

The agent always queries `needs-input` issues regardless of the ownership filter — these are the agent's own questions awaiting answers.

## Origin (group: `origin`)

| Label         | Color  | Description                                             |
| ------------- | ------ | ------------------------------------------------------- |
| `human`       | gray   | Created by a human                                      |
| `from-agent`  | indigo | Created by an agent (research finding, decomposed task) |
| `from-signal` | red    | Created from an external signal                         |

Note: `from-agent` and `from-signal` use the `from-` prefix because Linear requires unique label names team-wide, and `agent` and `signal` are already used by the group name and type label respectively.

## Confidence (group: `confidence`)

| Label    | Color  | Description                       |
| -------- | ------ | --------------------------------- |
| `high`   | green  | 0.8+ confidence in the hypothesis |
| `medium` | yellow | 0.6-0.8 confidence                |
| `low`    | red    | Below 0.6 confidence              |

Applied only to `type/hypothesis` issues.

## Not Labels: Priority, Estimate, Dependencies

Urgency, size, and dependencies use Linear's **native fields**, never labels:

- **Priority** → the native priority field (Urgent/High/Medium/Low). Do not create `priority/*` labels. (The `confidence/*` group above measures hypothesis confidence — it is not priority.)
- **Estimate** → the native estimate field (Fibonacci; 1 ≈ single agent session). See SKILL.md "Priority and Estimates".
- **Dependencies** → Linear blocking relations, not labels or description prose.

The orchestration extension sorts dispatch on these native fields, so labels duplicating them would drift.
