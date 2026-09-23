# Codex Fast Mode

Pi extension that adds `-fast` model aliases for available models from the `openai` and `openai-codex` providers. Selecting an alias sends the original model ID with the OpenAI `service_tier: "priority"` request field.

## Install

Install the umbrella Git package to load this extension alongside Plan Mode:

```bash
pi install git:github.com/pixelsnis/pi-extensions
```

To install just this extension from npm, after it has been published:

```bash
pi install npm:@pixelsnis/pi-codex-fast-mode
```

Restart Pi or run `/reload` after changing package settings. Remove it with `pi remove npm:@pixelsnis/pi-codex-fast-mode`, or remove the umbrella Git package with `pi remove git:github.com/pixelsnis/pi-extensions`.

## What it changes

At session startup, the extension wraps the registered `openai` and `openai-codex` providers when they are available. For each catalogued model whose ID does not already end in `-fast`, it offers an alias with:

- ID `<original-id>-fast`
- Display name `<original-name> (fast)`

If the provider's model catalog already contains that alias ID, the extension skips it rather than creating a collision. The alias maps back to the original model ID for requests and adds `service_tier: "priority"` to the provider payload, while preserving an existing payload callback. Ordinary model IDs pass through unchanged. Providers other than `openai` and `openai-codex` are not modified.

The suffix is a model selector alias, not a promise that a request will be faster. Priority-tier availability, billing, rate limits, and eligibility depend on the provider and account. A provider may reject the field or the requested tier. Check current provider terms and usage settings before selecting an alias.

## Verify without sending a request

Start Pi with the local extension, then inspect the model selector and look for `-fast` entries. Do not submit a prompt or select a fast alias just to test it:

```bash
pi --no-extensions -e ./extensions/codex-fast-mode
```

This check depends on the corresponding provider and model catalog being visible in your Pi installation. It does not require sending a model request.

## Troubleshooting

- **No `-fast` aliases:** Check that the `openai` or `openai-codex` provider is registered and has models in its catalog. A model ID already ending in `-fast` is not aliased; a colliding alias ID is skipped.
- **A priority request fails:** The provider or account may not accept `service_tier: "priority"`, or the requested tier may be unavailable. Retry with the original model ID and consult the provider's current documentation.
- **Normal model requests behave differently:** Only `openai` and `openai-codex` provider wrappers are installed, and only alias requests receive the priority payload transform. Report reproducible differences with the provider/model ID and Pi version.

## Local development

From the repository root, load only this extension in an isolated local Pi session with `pi --no-extensions -e ./extensions/codex-fast-mode`. The source is `index.ts`; no build step is required because Pi loads TypeScript extensions directly.
