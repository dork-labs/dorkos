---
id: 260925-000832
title: Disclose and bind the shell commands written into a package's skill and command text
status: accepted
created: 2026-09-25
spec: null
superseded-by: null
amends: [260924-114320]
---

# 260925-000832. Disclose and bind the shell commands written into a package's skill and command text

## Status

Accepted. Amends 260924-114320 ("Updates and global plugins run only what a person approved"): its claim that a skill's body is prose outside the disclosure is retired for the shell commands written into that body. Everything else in it stands.

## Context

Claude Code runs shell commands written into a skill's or command's text while it renders it, before the model sees it: an inline `` !`cmd` `` and a fenced block whose info string starts with `!`. OpenCode runs the inline form in command templates, and Harness Sync copies plugin commands into OpenCode wrappers. The install preview read only frontmatter, so these commands ran without being shown and outside the approval that DOR-2195 and DOR-2306 bind (DOR-2327).

Both programs fill the text typed after a command into its placeholders BEFORE running its shell commands: `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N` and a named `$name` from frontmatter `arguments` in Claude Code (read from its bundled CLI: arguments are substituted, escaped so they cannot add a command, then the commands run), and `$ARGUMENTS` and `$N` in OpenCode (`session/prompt.ts`, unescaped). So **the text a person or agent types after a command can shape what a disclosed command runs**.

## Decision

We read every skill, command, agent and output-style file the preview reads for these commands, with a parser that is a superset of both programs' own patterns (`@dorkos/skills/shell-commands`), and disclose each one like a hook command, naming the file it comes from. They are bound in `disclosedEffectsOf`, so a version that adds or edits one needs approval again. A command that names an argument placeholder is marked, and every surface says it uses the text typed after the command. A disclosure from an older client without the field reads as having none, and the stored global-approval digest leaves the field out while it is empty, so existing approvals keep matching.

## Consequences

### Positive

- A package can no longer run a command from skill text that nobody was shown, and changing one asks again.
- A person reading the card knows when typed text becomes part of a command.

### Negative

- Leaning wide lists some commands that would not actually run (a tilde fence, a double-backtick span); that costs a line on the card.
- An approval covers a command's text, not every value typed into it later. The card says so rather than pretending otherwise.
- Agent and output-style files are disclosed although Claude Code does not document running `!` there; this is the conservative reading.
