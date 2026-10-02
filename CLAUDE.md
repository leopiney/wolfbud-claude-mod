# wolfbud-claude-mod

Claude Code mods (function-hook plugins, Claude Code >= 2.1.287) that use ElevenLabs.

- Before touching anything under `mods/`, load the built-in `plugin-authoring` skill (the API) and this repo's `mod-dev` skill (layout, load/test loop, gotchas). If the mod talks to ElevenLabs, also load `elevenlabs-mod`.
- Each mod lives in `mods/<name>/`, not in `~/.claude/dev-mods/`. Mod names can't start with `claude-`.
- Done means: `claude plugin validate mods/<name>`, `npx -y -p typescript@5 tsc -p mods/<name>` and `(cd mods/<name> && claude plugin test)` all pass.
- Run a mod: `claude --plugin-dir ./mods/<name>` (it hot-reloads on save).
