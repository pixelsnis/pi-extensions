# Plan Mode

Pi extension for read-only planning followed by an explicit, user-selected approval handoff to Build mode.

## Install

Install the umbrella Git package to load both extensions and the bundled planning skill:

```bash
pi install git:github.com/pixelsnis/pi-extensions
```

To install just this extension from npm, after the package has been published:

```bash
pi install npm:@pixelsnis/pi-plan-mode
```

Restart Pi or run `/reload` after changing package settings. To remove an installation, use the same package source with `pi remove`, for example `pi remove npm:@pixelsnis/pi-plan-mode` or `pi remove git:github.com/pixelsnis/pi-extensions`.

## Modes and tool gate

Build is the default mode. `/plan` toggles between Build and Plan and updates the mode badge. `/plan-profile` displays the selected model profile; `/plan-profile <name>` changes it.

Plan mode is deny-by-default for **agent tool calls**. It permits `read`, `grep`, `find`, and `ls` for inspection; `plan_save` to write the current generated plan file; and `plan_present` to open explicit review. Bash is conditionally permitted only for simple read-only commands from this exact allowlist:

- `pwd`, `ls`, `find`, `grep`, `rg`, `cat`, `head`, `tail`, `wc`, `file`, and `stat`
- Git's `status`, `diff`, `log`, and `show` subcommands

For example, `ls -la`, `find . -type f -name '*.ts'`, and `rg -n "PLAN_TOOLS" extensions/plan-mode/index.ts | head -20` are accepted; every stage of a pipeline must independently pass the same command checks. The recognizer rejects unlisted commands, shell chaining, redirection, command/process substitutions, multiline input, wrappers, and known mutating or execution options (including `find -delete`, `find -exec*`, `file --compile`, Git external-diff/textconv/output options, and ripgrep preprocessor options). If a command cannot be parsed or its read-only behavior is uncertain, it is blocked. Interactive `!`/`!!` shell commands remain unconditionally blocked, as do other agent tools such as `write`, `edit`, and custom tools.

This is a tool gate, not an OS sandbox: extensions execute with Pi's normal process permissions. Pi still records extension state in the session, and the user-invoked `/plan-profile` command may update the profile selection in `plan-mode.json`.

The extension injects a hidden mode-context message, but does not display the plan inline. Its bundled `plan-writing` skill supplies the generic planning workflow and is included in both this package and the repository's root Pi manifest.

## Save and review a plan

1. Switch to Plan with `/plan` and ask Pi to inspect the project and prepare a plan.
2. The agent reads the `plan-writing` skill and saves the plan using `plan_save`. That tool accepts Markdown only; it never accepts a destination path. It returns a path relative to the session working directory.
3. The agent calls `plan_present` with only the exact relative path string returned by `plan_save`. Do not substitute an absolute path or another spelling, even if it resolves to the same file. In the Pi TUI, a scrollable review shows the plan and requires an explicit choice:
   - **R — Refine:** return to chat in Plan mode without recording approval.
   - **N — Approve & Execute:** start a linked fresh session in Build mode.
   - **H — Approve & Execute Here:** switch this session to Build mode and continue here.
   - **Esc — Cancel:** keep Plan mode active; no approval is recorded.

Approval uses a one-time handoff. Before execution, the extension checks that the plan still belongs to the source session and is readable, and that the selected profile has not changed. Stale, missing, or invalid plans do not execute. In a non-TUI run, `plan_present` cannot record approval and returns without executing.

The internal `/plan-handoff` and `/plan-build-start` commands carry the approved handoff. They are implementation details; use the review UI rather than invoking them directly.

## Plan-file location and safeguards

- In a Git project, the extension stores plans beneath the repository's Git administrative directory in `implementation-plans/` (normally `.git/implementation-plans/`). Plans are not ordinary tracked project files.
- Outside a Git project, it creates a unique `<project>-implementation-plans.*` directory under the operating system's temporary directory.
- The extension creates private directories/files, requires a non-empty plan no larger than 200 KiB, and rejects redirected directories, symlinks, and linked/non-regular plan files. It stores and validates the canonical absolute plan path internally, but `plan_present` accepts only the exact relative path string returned by `plan_save` for the current session working directory.

Keep the path returned by the tool; do not guess or substitute a path. Plans in temporary storage may be removed by the operating system.

## Model profiles

Optional configuration is read from `$PI_CODING_AGENT_DIR/plan-mode.json`, or `~/.pi/agent/plan-mode.json` when `PI_CODING_AGENT_DIR` is unset. A profile contains both Plan and Build model settings:

```json
{
  "profiles": {
    "work": {
      "plan": { "id": "provider/planning-model", "effort": "medium" },
      "build": { "id": "provider/build-model", "effort": "high" }
    }
  },
  "selectedProfile": "work"
}
```

Replace the example IDs with exact `provider/model-id` values available in your Pi installation. Configure one to five profiles. Profile names must be safe single tokens beginning with a letter or digit and may contain letters, digits, `_`, or `-`; `__proto__`, `constructor`, and `prototype` are reserved and rejected. Each profile must define both `plan` and `build`; each `effort` must be `default`, `low`, `medium`, `high`, `xhigh`, or `max`. Pi may clamp a level to what the selected model supports. Unknown fields, duplicate JSON keys, and an invalid `selectedProfile` are reported as configuration errors. If `selectedProfile` is omitted, the first profile in file order is selected.

The older top-level format remains supported:

```json
{
  "plan": { "id": "provider/planning-model", "effort": "medium" },
  "build": { "id": "provider/build-model", "effort": "high" }
}
```

`effort: "default"` does not force a level. Execute Here restores the level active on entry to Plan when Build uses `default`; a fresh session uses Pi's configured default. Missing or unavailable models and invalid configuration are reported. Selecting a profile persists it to the config file, so treat that file as user configuration rather than part of the plan-file write boundary.

## Troubleshooting

- **Plan tools are missing:** Confirm the extension loaded, then restart Pi or run `/reload`.
- **Plan mode appears inactive:** Use `/plan`; the badge shows the current mode and selected profile.
- **Approval does not start execution:** Review in the interactive TUI. Check that the plan path is still readable and that the configured Build model is available; stale handoffs require a new review.
- **A profile will not load:** Check JSON syntax, exact provider/model IDs, both `plan` and `build` entries, valid effort names, and model authentication.
- **A plan cannot be saved or reviewed:** Keep the exact tool-returned path and ensure the plan is non-empty and within 200 KiB. Do not replace its generated directory or file with a symlink.

## Local development

From the repository root, load just this package for a local session:

```bash
pi --no-extensions -e ./extensions/plan-mode
```

The bundled skill source is at `skills/plan-writing/SKILL.md`; the parent repository's root package also exposes it for the Git installation route.
