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

| Label       | Color  | Description                                 |
| ----------- | ------ | ------------------------------------------- |
| `ready`     | green  | Ready for automated agent pickup            |
| `claimed`   | yellow | Agent has claimed and is working on it      |
| `completed` | indigo | Agent completed, awaiting review/validation |

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
