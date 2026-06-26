# AGENTS.md

## Overview

This repository is a Zen Browser chrome mod forked from `Vertex-Mods/Zen-Tidy-Tabs`.

It injects a brush button and separator line into Zen's vertical tabs sidebar, then sorts ungrouped tabs into AI-generated groups. The fork keeps the original Firefox local ML path, adds an optional Gemini provider, and now treats the provider output as the source of truth for grouping.

## Files

- `tidy-tabs.uc.js`
  Main privileged browser-chrome script.
- `userChrome.css`
  Styles for the line, brush button, animations, and states.
- `theme.json`
  Sine/Zen mod manifest.
- `preferences.json`
  Sine settings surface for AI enablement, provider choice, and Gemini API key.
- `README.md`
  Public fork documentation and install instructions.

## Runtime Constraints

- This code runs in Zen/Firefox chrome context, not web-page context.
- It depends on Zen globals and browser internals such as `gBrowser`, `gZenWorkspaces`, `gZenUIManager`, and `MozXULElement`.
- DOM timing is fragile. Zen may re-render the sidebar separators and workspace containers at any time.
- There is no build step or automated test suite.

## Current Product Behavior

- Injects the sort UI into `.pinned-tabs-container-separator`.
- Sorts only tabs from the active workspace.
- Passes current tabs and existing group context to the selected provider.
- Reuses an existing group only by exact normalized name when the provider chooses it.
- Creates new groups directly from provider-returned topic names.
- Leaves unassigned tabs untouched unless the provider explicitly places them in `Others`.
- Preserves grouped tabs during Zen's clear-tabs flow.
- Falls back to Firefox local AI if Gemini fails.

## Provider Model

The mod supports two providers:

- `firefox-local`
  Default. Uses Firefox local ML models and cached embeddings.
- `gemini`
  Optional cloud mode. Requires `extension.zen-tidy-tabs.gemini-api-key`.

The settings UI intentionally keeps the Gemini API key field always visible. Sine's conditional preference rendering currently throws in `preferences.sys.mjs`, so do not reintroduce conditional field visibility unless that upstream bug is confirmed fixed.

## Grouping Intent

The provider prompt should group by task and browsing context, not by narrow page-title fragments.

Good outcomes:

- several GitHub, docs, and search tabs for the same task collapse into one broader task group
- existing groups are reused only when the provider intentionally names them
- miscellaneous tabs land in `Others` only if the provider decides they should

Bad outcomes:

- many single-tab groups
- local code silently renaming or merging provider output
- local heuristics overriding what the provider already decided

## Important Areas In `tidy-tabs.uc.js`

- provider selection and request fallback
- local embedding cache behavior
- provider prompt and JSON parsing
- direct assignment-to-group translation
- sidebar injection and visibility updates
- clear-tabs patching

Be careful when changing any of those paths because failures are visible directly in the browser UI.

## Editing Rules

- Keep logic scoped to the active workspace via `zen-workspace-id`.
- Preserve compatibility with existing tab groups and `Advanced-Tab-Groups`.
- Do not assume sidebar parents exist; guard DOM access aggressively.
- If JS changes IDs or selectors, update `userChrome.css` in lockstep.
- Prefer soft failure and fallback over throwing from chrome context.
- Do not reintroduce local semantic merge logic unless the product intent changes.
- Use ASCII unless the file already needs something else.

## Validation

Manual validation in Zen is required:

1. Import or reload the mod through Sine Mods.
2. Confirm the separator line and brush button appear when sortable tabs exist.
3. Test both providers.
4. Test existing-group reuse by exact provider-chosen name plus new-group creation.
5. Confirm `Others` only appears when the provider explicitly returns it.
6. Confirm clear-tabs still preserves grouped tabs.
