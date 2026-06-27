---
description: First-run setup for /flow - pick your tracker, generate its adapter, and scaffold config
category: flow
allowed-tools: Read, Glob, AskUserQuestion, Write, Edit, Skill, Bash(node:*), Bash(cp:*), Bash(test:*), Bash(grep:*), Bash(cat:*)
argument-hint: '[--reconfigure]'
---

# /flow:init - first-run setup

Set up `/flow` in this repo: $ARGUMENTS

Read `.agents/flow/skills/initializing-flow/SKILL.md` and follow its process
exactly. It is the one-time setup entry point: it detects whether `/flow` is
already configured, gathers your setup choices (tracker + connection, identity
mode, project routing), generates the concrete adapter for your tracker, writes
the committed `config.json` plus the gitignored `config.local.json`, and confirms
the install with a dry dispatch.

This command never names a tracker API directly. The adapter it generates is the
single tracker-aware component; everything else stays generic. If `/flow` is
already configured, the skill treats this as a reconfigure and never clobbers
committed config without your confirmation.

Pass `--reconfigure` to jump straight to reconfiguring an existing install.
