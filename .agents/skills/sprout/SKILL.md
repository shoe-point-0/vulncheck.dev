---
name: sprout
description: Fast, offline, dependency-free spec-driven development CLI. Manages task packets through tracer bullet, hot path exploration, safe passage, and closing review promotion to feature documentation.
---

# Sprout Skill Guide

Sprout turns short requests into portable, spec-driven tasks and guards their transition from active work to durable feature documentation.

When this skill is invoked inside a coding-agent session, perform the workflow in that current session. Do not use `sprout run` to launch a nested copy of the same agent; that command is a shell convenience for users and automation.

For a new request, begin with `sprout new "<request>"`. Use the created task ID throughout the workflow, keep its canonical packet current as work progresses, and preserve the user's requested scope.

## The 5-Step Development Workflow

1. **Lay of the Land**: Inspect relevant code, tests, and repository instructions to establish context.
2. **Tracer Bullet**: Implement the minimal, end-to-end spike to prove feasibility in the shortest possible path.
3. **Hot Path Exploration**: Flesh out the primary execution path and core logic laid down by the tracer bullet.
4. **Safe Passage**: Harden the code, verify edge cases, and run the full test and verification suite.
5. **Closing Review**: Fill out technical approach, validation evidence, and outcome, then run `sprout close <id>` to promote the spec to `docs/features/<id>.md`.

## Sprout CLI Command Reference

- `sprout new "Request title"` — Compile a request into `.sprout/tasks/<id>.md`
- `sprout list` — List active tasks
- `sprout show <id>` — Print task packet Markdown
- `sprout check <id>` — Validate task packet structure
- `sprout check --complete <id>` — Validate completion requirements before closure
- `sprout commit <id> --type fix --scope repo` — Draft a conventional commit message from a completed packet
- `sprout commit <id> --check .git/COMMIT_EDITMSG` — Validate a commit message file against the completed packet
- `sprout run --agent <agent> <id>` — From a shell, launch agent (`agy`, `codex`, `hermes`, `cursor`, `opencode`) with the task
- `sprout close <id>` — Promote completed task packet to `docs/features/<id>.md`
- `sprout doctor` — Verify repository structure and agent setup
