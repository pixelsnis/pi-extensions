---
name: plan-writing
description: Use when preparing or revising an implementation plan for a multi-step software change, or handing an approved plan to a fresh-context implementer.
---

# Writing Implementation Plans

An implementation plan is an execution specification: an implementer who has not seen the planning conversation should be able to follow it in order, make no design decisions, and tell when each step is complete.

## Explore before planning

1. Read the full request, specifications, project instructions, and relevant source/configuration. Find existing utilities and callers before proposing new ones.
2. During planning, do not edit application files or run state-changing commands. The only file to create or update is the temporary plan.
3. Ground paths, symbols, interfaces, behavior, and commands in sources inspected during this task. Mark unconfirmed details `unverified — confirm first`; never present guesses as facts.
4. Resolve uncertainty by inspection first. Ask only when a real unresolved preference changes behavior, scope, or architecture. Recommend a default and give a fallback for any assumption that could block implementation.
5. Draft and revise the plan as you learn. Reuse an existing plan only when it is for this same task.

## Plan location

Keep the plan outside the tracked working tree. For a Git project, use the checkout's Git administrative directory:

```bash
project_root="$(git rev-parse --show-toplevel)"
git_admin_dir="$(git -C "$project_root" rev-parse --absolute-git-dir)"
mkdir -p "$git_admin_dir/implementation-plans"
```

Save to `$git_admin_dir/implementation-plans/<short-kebab-case-slug>-plan.md`. For a non-Git project, create a unique directory under `${TMPDIR:-/tmp}` prefixed with the project directory name, and save the plan there. When using Plan Mode's `plan_save`, use and report only the exact relative path it returns; the extension may retain the canonical absolute path internally, but callers must not substitute or expose it. Never put a temporary plan in tracked documentation or commit it.

## Required plan structure

Use this template, scaling its depth to the change:

```markdown
# [Feature] Implementation Plan

**Context:** [2–4 sentences: request, need, intended outcome.]

**Approach:** [Short overview of ordered changes.]

**Constraints:** [Only load-bearing requirements.]

**Assumptions and contingencies:** [User-overridable decisions and fallback, or “None.”]

## Implementation steps

### Step 1: [Behavior or deliverable]

**Depends on:** [Earlier steps or “None”]
**Files:** [Exact paths and create/modify actions]
**Interfaces:** [Exact signatures, schemas, callers, errors, or “None”]
**Change:** [Concrete ordered actions and boundary/error handling]
**Done when:** [Observable success condition]

- [ ] [Executable action]
- [ ] [Executable action]

## Critical files and anchors

- `[verified/path]`, `[symbol/region]` — [why it matters]

## Verification

- [Action/input] → [observable expected result]

## Assumptions and contingencies

[Only decisions the user may override; include fallback, or “None.”]
```

Each implementation step must specify the exact files, behavior, interfaces and data shapes, error/empty/invalid/boundary cases, and an observable completion condition. Order dependent work; mark parallel work only when interfaces and files are independent. Identify every caller affected by a changed interface or provide an exact search command. Critical files should be verified and limited to five. Keep assumptions user-overridable; resolve implementation decisions in the steps instead of deferring them.

## Verification and scope

Include at least one behavior-specific check with its input/action and expected result. Give exact commands and prerequisites when tests are requested or required by project instructions. Otherwise, do not add tests, commits, documentation, or cleanup tasks unless requested or required; state verification limits when no check is authorized.

## Fresh-context handoff

When handing work to a fresh Pi session through Plan Mode approval, rely on the session's existing working directory; do not inject or request an absolute project root. Refer to the approved plan using only the exact relative path returned by `plan_save`, and include the exact step or scope and execution constraints. The handoff itself must direct the new implementer to:

1. Inspect `git status --short --branch` from the existing working directory, preserving existing changes.
2. Read project instructions for the assigned files.
3. Read the plan context, constraints, applicable assumptions, the full assigned step, and its named sources/interfaces.
4. Stop and report any conflict or missing required decision instead of guessing.

The implementer must make only the assigned changes, follow the plan in order, run only authorized/required verification, and report changed files, commands/results, remaining issues, and commits.
