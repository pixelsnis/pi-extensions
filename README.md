# Pi Extensions

A small monorepo for two Pi extensions: deny-by-default Plan Mode with explicit approval, and `-fast` aliases for OpenAI/OpenAI Codex models. Each extension lives in its own package under `extensions/`; the repository root is an umbrella Pi package that loads both extensions and Plan Mode's bundled `plan-writing` skill.

## Repository layout

```text
.
├── package.json                         # npm workspace + umbrella Pi package
└── extensions/
    ├── plan-mode/
    │   ├── index.ts                     # /plan, profile config, gated tools and approval flow
    │   ├── plan-file.ts                 # guarded plan-file storage
    │   ├── review-ui.ts                 # explicit TUI approval UI
    │   └── skills/plan-writing/SKILL.md  # packaged planning workflow
    └── codex-fast-mode/
        └── index.ts                     # OpenAI/OpenAI Codex priority aliases
```

## Install both extensions from GitHub

Install the root Pi package to load both extensions together, including the Plan Mode skill:

```bash
pi install git:github.com/pixelsnis/pi-extensions
```

This installs globally by default. To add it to the current project instead, use `pi install -l git:github.com/pixelsnis/pi-extensions`. The project must be trusted before its project-local Pi resources load.

To remove the umbrella package:

```bash
pi remove git:github.com/pixelsnis/pi-extensions
```

## Install one extension from npm

Each child package has independent public-scoped npm metadata. These commands become usable **after the packages are published to npm**; this repository task does not publish them:

```bash
pi install npm:@pixelsnis/pi-plan-mode
pi install npm:@pixelsnis/pi-codex-fast-mode
```

See [Plan Mode](extensions/plan-mode/README.md) and [Codex Fast Mode](extensions/codex-fast-mode/README.md) for behavior, safety details, and package-specific removal instructions.

## Local development and checks

Pi loads TypeScript extensions directly; no transpilation/build step is needed. From the repository root, load the umbrella package or an individual extension in an isolated local Pi run. `--no-extensions` prevents conflicts with globally installed copies during this smoke check; explicit `-e` paths still load:

```bash
pi --no-extensions -e .
pi --no-extensions -e ./extensions/plan-mode
pi --no-extensions -e ./extensions/codex-fast-mode
```

Inspect the package file sets before publishing:

```bash
npm pack --workspace=@pixelsnis/pi-plan-mode --dry-run
npm pack --workspace=@pixelsnis/pi-codex-fast-mode --dry-run
```

The Plan Mode tarball should contain its entry and imported TypeScript files, README, and `skills/plan-writing/SKILL.md`. The Codex Fast Mode tarball should contain its entry and README. The child manifests use `files` allowlists to exclude unrelated repository content.

## Compatibility and behavior

Pi's package loader must support `pi` manifests, TypeScript extensions, and the APIs used by these sources. No minimum Pi version is asserted here. The extensions rely on Pi-provided packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, and `typebox`) rather than bundling duplicate copies; the child manifests declare the relevant peer dependencies.

- **Plan Mode** starts in Build mode. `/plan` switches to a deny-by-default agent-tool gate for planning, with Bash conditionally available only for validated read-only inspection commands, pipelines, and `&&` chains unless the exact tool name `bash` is added to the global `allowedTools` list. For example, `pwd && ls -la` and `rg -n 'PLAN_TOOLS\b' extensions/plan-mode/index.ts` are accepted; all commands in a pipeline or chain must be allowed by the default filter. Other chaining/operators remain blocked by default. Exact, case-sensitive names in `allowedTools` are additive trusted exceptions for third-party or built-in tools; omitted or empty preserves the default gate. The user reviews the generated plan in a TUI before choosing whether and where to execute it. The gate is not an operating-system sandbox; see the [Plan Mode security notes](extensions/plan-mode/README.md#modes-and-tool-gate).
- **Codex Fast Mode** creates `-fast` aliases only for catalogued `openai` and `openai-codex` models and adds `service_tier: "priority"` to alias requests. Provider/account access and billing rules apply; see [Codex Fast Mode](extensions/codex-fast-mode/README.md#what-it-changes).

## Security

Pi extensions run with the process's normal privileges and can execute arbitrary code. Review the source before installing. Plan Mode restricts agent tool calls while planning by default; Bash is accepted only for simple validated read-only commands, pipelines, and `&&` chains (for example, `pwd && ls -la` or `rg -n '.*;$' extensions/plan-mode/index.ts`) unless `bash` is explicitly trusted in `allowedTools`. Every command must independently pass the default allowlist and option checks. Other shell chaining/operators such as `;`, `||`, and `&`, along with redirection, substitutions, unrecognized commands, mutating/execution options, and interactive `!`/`!!` commands remain blocked by default; interactive user Bash remains blocked even when agent `bash` is allowlisted. `allowedTools` is an explicit trust boundary: Plan Mode does not inspect side effects, so allowlisting a third-party tool or mutating built-in such as `write` or `edit` permits every call to that exact name. This is not a filesystem, process, or network sandbox; user-invoked extension commands and Pi's own session persistence remain outside that agent-tool restriction. Codex Fast Mode changes outgoing request payloads for its aliases; provider eligibility, charges, and rate limits remain the user's responsibility. See the [Plan Mode tool-gate details](extensions/plan-mode/README.md#modes-and-tool-gate).
