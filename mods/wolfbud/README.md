# wolfbud

A voice coworker beside your Claude Code session. WolfBud watches the session (your prompts, Claude's tool calls, failures, final answers, permission prompts). You talk things through with it on a call, and when you agree on something it sends the prompt to Claude for you.

Tested on Claude Code 2.1.287 (macOS, Google Chrome).

```
Claude Code ── wolfbud mod (hooks/register.tsx) ──────────────┐
  prompts, tool calls, turns,        spawns, reads stdout      │  pane: call status, transcript,
  notifications ───────────────► bridge/server.mjs ◄── POST ──┘  everything sent to Claude
                                   127.0.0.1:4747
                                   │ SSE ▲ POST    ▲ token (API key stays here)
                                   ▼     │         │
                          WolfBud window (window/ → bridge/window)
                          3D wolf + ElevenLabs voice agent (WebRTC)
```

- **The window** holds the call, because a mod's sandbox has no microphone, sockets or WebGL. In Orca it opens as a tab in Orca's built-in browser; elsewhere as a small Chrome app window with its own profile, so the mic grant sticks and the pane can start calls without a click.
- **What the agent hears:** a snapshot of the session when the call starts, rolling `[claude activity]` updates (quiet context), and `[claude event]` messages when Claude finishes a task or waits for permission. Those wait for a pause, so WolfBud doesn't talk over you.
- **What the agent can do:** `wolfbud_send_to_claude` turns what you decided into a prompt:
  - Claude idle: a new turn starts.
  - Claude busy, `now`: a note goes into the running turn.
  - Claude busy, `after_current`: the prompt is queued.

  It can also stop Claude with `wolfbud_stop_claude` (only when you ask) and look up details with `wolfbud_claude_activity`.

## Install

The repo is a marketplace (`.claude-plugin/marketplace.json`), so the mod installs from GitHub into every session, desktop app included. Nothing to build: the window ships built in `bridge/window`.

```bash
claude plugin marketplace add leopiney/wolfbud-claude-mod
claude plugin install wolfbud@elevenlabs-mods
printf '{"api_key":"%s"}' "$ELEVENLABS_API_KEY" | claude plugin configure wolfbud@elevenlabs-mods --values-stdin   # kept in secure storage; or export ELEVENLABS_API_KEY
```

Restart Claude Code. On first use the bridge finds or creates the agent in the key's ElevenLabs account and syncs it to the definition (see [Changing the agent](#changing-the-agent)).

To install a clone instead, run `ELEVENLABS_API_KEY=… pnpm run install-plugin` from its root (`--dry-run` lists the steps), or by hand: `pnpm install && pnpm window:build`, then the commands above with `claude plugin marketplace add "$(pwd)"` (an absolute path; "." fails). Both marketplaces are named `elevenlabs-mods`, and only one can be added at a time: `claude plugin marketplace remove elevenlabs-mods` (which uninstalls the mod) before you switch.

The install is a copy cached by version, so to ship a change:

1. Bump `version` in `.claude-plugin/plugin.json`.
2. Commit. The pre-commit hook rebuilds the window when `window/`, the dependencies or the version changed, and checks the agent definition when it changed.
3. Push. Installs pick it up with `claude plugin update wolfbud@elevenlabs-mods` (auto-update is off by default for this marketplace) and a restart. An install from a clone also needs `claude plugin marketplace update elevenlabs-mods` first.

While developing, load the repo copy instead (it hot-reloads):

```bash
claude --plugin-dir ./mods/wolfbud
```

## Use

| | |
| --- | --- |
| `/wolfbud` | open the pane and the window |
| `/wolfbud call` | same, and start the call |
| `/wolfbud end` | hang up |
| `/wolfbud window` | open a fresh window |
| `/wolfbud status` | bridge, window, call, and anything missing |
| `/wolfbud stop` | end the call and stop the bridge |

The pane's buttons (`c` call, `e` end, `w` window) do the same. In the fullscreen layout the pane docks beside the transcript.

## Options

`userConfig` in `.claude-plugin/plugin.json`:

| Option | Default | |
| --- | --- | --- |
| `api_key` | `$ELEVENLABS_API_KEY` | Used by the bridge to mint call tokens. Sensitive. |
| `port` | 4747 | Preferred bridge port; the next nine are tried. Keep it stable: the mic grant is per origin. |
| `browser` | `auto` | `auto` opens the window in Orca's built-in browser when the session runs in an Orca terminal, else a Chrome app window. `chrome-app` always opens the Chrome app window. `orca-browser` opens the window as a tab in Orca's built-in browser, `terminal-browser` in a split pane of your terminal (see below). `default` opens your default browser instead; you then click Call in the window. |

### In Orca (orca-browser)

WolfBud is optimized for the [Orca](https://orca.build) terminal: the window opens as a tab in Orca's built-in browser, next to the session, instead of a separate Chrome window. This is the default (`browser: auto`) whenever the session runs in an Orca terminal; set `browser` to `chrome-app` to opt out.

```bash
WOLFBUD_BROWSER=orca-browser claude --plugin-dir ./mods/wolfbud   # force it; `auto` already does this inside Orca
```

**Orca setup.** What has to be true for it to work:

- **Run Claude Code in a terminal Orca manages, with Orca running.** Orca sets `ORCA_WORKTREE_ID` in those terminals, and WolfBud looks for it at launch. It's the only thing checked; if it's missing, WolfBud toasts that the session isn't in Orca and opens the Chrome app window instead.
- **The `orca` CLI has to work.** WolfBud runs `orca tab create --url <url> --json`, trying `orca` on PATH first and then `/Applications/Orca.app/Contents/Resources/bin/orca` (the PATH one can be a dead symlink). If both fail it falls back to the Chrome app window.
- **No Orca skills are required.** WolfBud only calls the CLI. The bundled `orca-cli` skill matters only if you want an agent to drive the tab (`orca skills install` adds it).
- **Allow the microphone for Orca.** The window needs `getUserMedia`. On macOS that means Orca under System Settings → Privacy & Security → Microphone, and allowing the prompt for the tab if it asks. Orca has no WolfBud-specific permission setting, and I haven't confirmed how it persists the grant per origin. Keep `port` stable so the origin doesn't change.
- **Click Call in the tab if the pane can't start it.** Orca's browser can't take Chrome's autoplay flag, so the pane's call button may not start audio on its own.

Not tested yet on Claude Code 2.1.288.

### In your terminal (terminal-browser)

With [terminal-browser](https://github.com/zenbu-labs/terminal-browser) installed, WolfBud's window can open as a split pane next to Claude Code instead of a floating Chrome window. It runs `terminal-browser new-tab <url>`, and falls back to the Chrome app window if that fails. It needs a terminal terminal-browser supports (kitty graphics: Ghostty, kitty, cmux, tmux, herdr, WezTerm, VS Code). The mic must be allowed for terminal-browser's browser. Not tested yet on Claude Code 2.1.288.

```bash
WOLFBUD_BROWSER=terminal-browser claude --plugin-dir ./mods/wolfbud   # or set the `browser` option
```

Env overrides: `WOLFBUD_BROWSER` (`chrome-app`, `orca-browser`, `terminal-browser` or `default`, wins over the option), `WOLFBUD_AGENT_ID` (an agent to use as it is, never synced; else the one the bridge set up), `WOLFBUD_NODE` (else `node` on PATH).

## Changing the agent

`elevenlabs/agent.json` (settings, tools) and `elevenlabs/prompt.md` (system prompt) are the source of truth, and every install syncs its user's own agent to them. The mod keeps the agent's id in `$.store` with a hash of the definition. A bridge whose definition hashes differently (an edit, or a plugin update that changed it) syncs again before the first call. So does one whose saved agent is gone (deleted, or in another account than the key's).

- `pnpm agent:sync` syncs by hand. `pnpm agent:sync --dry-run` checks the definition (no em dashes: the agent would copy them) and prints what a sync sends; the pre-commit hook runs it. `pnpm agent:simulate` runs a simulated call, no mic needed.
- The sync is `bridge/agent.mjs`: plain REST calls, no SDK, so an install needs no packages. Client tools upsert by name, the agent is found or created by name, and an update sends only what the definition owns. The agent PATCH deep-merges, so a setting tried in the dashboard survives until it's codified here.
- Tool names are the contract with `window/src/call.ts`: rename both or neither.
- Renaming the agent creates a new one; delete the old one in the dashboard.
- Models: `deepseek-v41-flash` (LLM) and `eleven_v4_turbo` (TTS). English agents are refused the v2.5 TTS models (`eleven_flash_v2_5`, `eleven_turbo_v2_5`).
- The voice is from the Voice Library and allows free users. Agents use it by id, so no account has to add it first.
- v4 can speak inline audio tags (`[laughing]`); the window strips them from captions and the pane.

## Security

- The bridge listens on 127.0.0.1 only and checks a per-session key on every `/api` route. It also rejects other `Host` and `Origin` values, so a web page can't post prompts into Claude's chat.
- The agent requires signed tokens, so its id alone can't start a call.
- The ElevenLabs key goes to the bridge process through the environment and never reaches the browser.
- Prompts reach Claude framed as coming from the wolfbud plugin ("The user asked WolfBud … to pass this on"), and the pane lists each one.

## Development

```bash
claude plugin validate mods/wolfbud
npx -y -p typescript@5 tsc -p mods/wolfbud
(cd mods/wolfbud && claude plugin test)
pnpm window:typecheck && pnpm window:build
```

The tests stand a fake bridge beneath the plugin (`tests/wolfbud.test.tsx`). The kit can't store a plugin's `session.append`, so the mid-turn note's success path is only exercised in a real session. Its fallback (queue the prompt) is tested.
