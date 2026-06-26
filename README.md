# Better Tidy Tabs

`Better Tidy Tabs` is a fork of [Vertex-Mods/Zen-Tidy-Tabs](https://github.com/Vertex-Mods/Zen-Tidy-Tabs) for Zen Browser.

This version keeps the original sidebar integration, but changes the sorter so the AI decides the final groups instead of the extension trying to "fix" them afterward.

## What It Does

When you click the brush icon in Zen's vertical tabs sidebar, the mod:

- collects ungrouped tabs from the current workspace
- asks the selected AI provider to decide how they should be grouped
- reuses an existing group only if the provider intentionally chooses that exact group
- creates any new groups directly from the provider response

The goal is simple: let the model group tabs by what you are actually doing, not by tiny title fragments.

## Why This Fork Exists

The upstream idea was solid, but the local post-processing could still split work into too many tiny groups. This fork moves more of that decision-making into the AI itself so the result is closer to your actual task.

## Install In Sine Mods

Install directly from GitHub inside Zen:

1. Open `Settings`.
2. Open `Sine Mods`.
3. Click `Import`.
4. Paste this repository URL:

```text
https://github.com/Reomar/better-tidy-tabs
```

5. Confirm the install.
6. Reload or restart Zen if Sine asks for it.

Sine installs the mod by reading `theme.json` from the repo and syncing the files into your Zen profile.

## Settings

The mod exposes three settings:

- `Enable AI`
- `AI Provider`
- `Gemini API Key`

## Provider Options

### Firefox Local

- default option
- runs on-device
- uses Firefox local ML models
- best if you want privacy and zero API cost

### Gemini

- optional cloud option
- requires a Gemini API key
- tries Gemini first and falls back to Firefox local if Gemini is unavailable
- better when you want broader task grouping than the local model can provide

## What To Expect

Good results usually look like this:

- tabs about one coding task end up in one shared work group
- existing groups get reused when they are clearly relevant
- unrelated leftovers may be placed in `Others`

The sorter is still AI-driven, so results depend on the model and your tab mix.

## Notes

- This is a browser chrome mod, not a normal web app.
- There is no build step or automated test suite here.
- Real validation is manual testing inside Zen Browser with Sine Mods.
