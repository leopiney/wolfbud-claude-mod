# wolfbud

A voice coworker beside your Claude Code session. WolfBud watches the session (your prompts, Claude's tool calls, failures, final answers, permission prompts). You talk things through with it on a call, and when you agree on something it sends the prompt to Claude for you.

Tested on Claude Code 2.1.292 (macOS, Google Chrome).

```
Claude session A ── wolfbud mod ── subscribe, events, long-poll ──┐
Claude session B ── wolfbud mod ── subscribe, events, long-poll ──┤
                                                                  ▼
                                                         bridge/server.mjs
                                                         127.0.0.1:4747  (one hub)
                                                                  │ SSE
                                                                  ▼
                                                         one Chrome app window
                                                         roster + 3D wolf + one call
```

The hub is not a child of any Claude session. The first `/wolfbud` that finds it down runs `bridge/launch.mjs`, which starts `server.mjs` detached, waits for it to answer, and exits. Later sessions only subscribe; a session that is already subscribed only raises the window. Claude cannot inject a prompt from outside a session, so each mod stays: it is the hands for that session only. The hub never calls Claude. It queues a command; the matching mod pulls it and runs `deliver()`. Each pull also carries the call's state, so a reloaded session sees the present rather than a replay.

- **One window.** A Chrome app window with its own profile at `~/.wolfbud/chrome`, so the mic grant sticks and a call can start without a click. The hub opens it once and raises it after that. Orca and terminal-browser are not faces for the wolf.
- **Many sessions, one call.** Each `/wolfbud` adds a roster row and a short name (`auth`, `auth-2`). The voice tools take that name and default to the focused session. A second session that needs you is a badge, or a `[session event]` on the call already live. Not a second call.
- **What the agent hears:** a snapshot of the focused session when the call starts, rolling `[claude activity]` updates, `[claude event]` for that session, and `[session event]` when another subscribed Claude finishes or waits on permission.
- **What the agent can do:** `wolfbud_send_to_claude` (optional `session`) turns what you decided into a prompt in that session:
  - Claude idle: a new turn starts.
  - Claude busy, `now`: a note goes into the running turn.
  - Claude busy, `after_current`: the prompt is queued.

  It can also stop that Claude with `wolfbud_stop_claude` (only when you ask) and look up details with `wolfbud_claude_activity`.

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

1. Commit. The pre-commit hook bumps `version` in `.claude-plugin/plugin.json` when the commit changes what ships (`window/` or the mod, minus its tests and docs). It bumps the patch once per branch, counted from `origin/main`, so a branch's commits ship as one release. `VERSION_BUMP=minor git commit …` (or `major`) picks the level, and `VERSION_BUMP=none` skips it. It then rebuilds the window when `window/`, the dependencies or the version changed, and checks the agent definition when it changed.
2. Push. Installs pick it up with `claude plugin update wolfbud@elevenlabs-mods` (auto-update is off by default for this marketplace) and a restart. An install from a clone also needs `claude plugin marketplace update elevenlabs-mods` first.

While developing, load the repo copy instead (it hot-reloads):

```bash
claude --plugin-dir ./mods/wolfbud
```

## Use

|                   |                                                                        |
| ----------------- | ---------------------------------------------------------------------- |
| `/wolfbud`        | subscribe this session, open the pane, and show the one window         |
| `/wolfbud call`   | same, focus this session, and start the call if it is not already live |
| `/wolfbud end`    | hang up the one call. Other subscriptions stay                         |
| `/wolfbud window` | raise the window and focus this session                                |
| `/wolfbud status` | hub, window, call, and anything missing                                |
| `/wolfbud hide`   | close the pane and fold it into one status line. `/wolfbud` unfolds it |
| `/wolfbud stop`   | unsubscribe this session only. Another Claude's wolf stays up          |

The pane's buttons (`c` call, `e` end, `w` window, `h` hide) do the same. In the fullscreen layout the pane docks beside the transcript.

## Remote sessions

A Claude session in a sandbox, a VM or a container can join the same call. **The hub always runs on your own machine**, because that's where Chrome, the mic and the ElevenLabs key are. The mod only makes outbound requests to `127.0.0.1:4747`, so the remote host doesn't expose anything. It only needs a tunnel back to your machine and the hub token.

1. **Start the hub on your machine first.** Run `/wolfbud` in any local Claude session.
2. **Tunnel port 4747 from the remote back to your machine.** From your machine:

   ```bash
   ssh -N -o ExitOnForwardFailure=yes -R 127.0.0.1:4747:127.0.0.1:4747 you@remote   # or autossh -M 0 … to keep it up
   ```

   Anything that makes `127.0.0.1:4747` on the remote reach `127.0.0.1:4747` on your machine as raw TCP works too, for example Tailscale (`tailscale serve --tcp 4747 tcp://127.0.0.1:4747` on your machine, `socat TCP-LISTEN:4747,bind=127.0.0.1,fork TCP:<your-machine>:4747` on the remote). An HTTP proxy that rewrites `Host` doesn't work, because the hub rejects any `Host` other than `127.0.0.1:4747`.

3. **Copy the hub token into the remote's hub config.** Copy only the token, not the window key:

   ```bash
   jq '{token}' ~/.wolfbud/hub.json | ssh you@remote 'mkdir -p -m 700 ~/.wolfbud && umask 077 && cat > ~/.wolfbud/hub.json'
   ```

   The token survives hub restarts, so you copy it once.

4. **Install the mod on the remote and run `/wolfbud` there.** Don't set an ElevenLabs key on the remote: the hub on your machine already has one.

A session counts as remote when it runs under SSH (`SSH_CONNECTION`) or as a Claude Code cloud session (`CLAUDE_CODE_REMOTE=true`). For a container you `docker exec` into, set `WOLFBUD_REMOTE=1`. If you SSH into your own machine and want it treated as local, set `WOLFBUD_REMOTE=0`. A remote session never starts a hub of its own. If it did, that hub would have no window and would take the port the tunnel needs when it reconnects.

If something is missing, a remote session tells you which step:

| What you see                                           | Fix                                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| `Can't reach the WolfBud hub from this remote session` | The hub isn't running on your machine, or the tunnel is down: steps 1–2 |
| `this machine has no hub token`                        | Step 3                                                                  |
| `The hub refused the token`                            | The token is stale or wrong: step 3 again                               |

The status line reads `WolfBud ✕ can't reach your machine's hub` until the tunnel is back, and the mod reconnects by itself every 2s. `/wolfbud status` adds `(remote session: through the tunnel to your machine)` once it's connected.

In the window's session list, each session shows where it runs: `local` for this machine, or `@host` with a dashed outline for a remote one. Hover a session for the full text. The host name comes from `WOLFBUD_HOST`, else `HOSTNAME`, else the SSH server's address. The voice agent also hears which sessions are remote.

## Options

`userConfig` in `.claude-plugin/plugin.json`:

| Option    | Default               |                                                                                                                                                                                    |
| --------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api_key` | `$ELEVENLABS_API_KEY` | The hub mints call tokens with it. Sensitive. Each `/wolfbud` hands it to the hub, which keeps the first non-empty one, so a session with a key repairs a hub started without one. |

The window is always one Google Chrome app window on `127.0.0.1:4747`. The port does not walk: the mic grant is per origin.

Env overrides: `WOLFBUD_AGENT_ID` (an agent to use as it is, never synced; else the one the hub set up), `WOLFBUD_NODE` (else `node` on PATH, used only to run the launcher), `WOLFBUD_REMOTE` (`1` or `0`: force remote or local, see [Remote sessions](#remote-sessions)), `WOLFBUD_HOST` (the name a remote session shows in the session list).

## Changing the agent

`elevenlabs/agent.json` (settings, tools) and `elevenlabs/prompt.md` (system prompt) are the source of truth, and every install syncs its user's own agent to them. The hub keeps the agent's id in `~/.wolfbud/agent.json` with a hash of the definition. A hub whose definition hashes differently (an edit, or a plugin update that changed it) syncs again before the first call. So does one whose saved agent is gone (deleted, or in another account than the key's).

- `pnpm agent:sync` syncs by hand. `pnpm agent:sync --dry-run` checks the definition (no em dashes: the agent would copy them) and prints what a sync sends; the pre-commit hook runs it. `pnpm agent:simulate` runs a simulated call, no mic needed.
- The sync is `bridge/agent.mjs`: plain REST calls, no SDK, so an install needs no packages. Client tools upsert by name, the agent is found or created by name, and an update sends only what the definition owns. The agent PATCH deep-merges, so a setting tried in the dashboard survives until it's codified here.
- Tool names are the contract with `window/src/call.ts`: rename both or neither.
- Renaming the agent creates a new one; delete the old one in the dashboard.
- Models: `deepseek-v41-flash` (LLM) and `eleven_v4_turbo` (TTS). English agents are refused the v2.5 TTS models (`eleven_flash_v2_5`, `eleven_turbo_v2_5`).
- The voice is from the Voice Library and allows free users. Agents use it by id, so no account has to add it first.
- v4 can speak inline audio tags (`[laughing]`); the window strips them from captions and the pane.

## Security

- The hub listens on 127.0.0.1 only and rejects other `Host` and `Origin` values. Remote sessions reach it through a tunnel you open (see [Remote sessions](#remote-sessions)). Don't expose port 4747 on a public URL: the window routes would be reachable too.
- Three keys. `~/.wolfbud/hub.json` holds the service token a mod uses to subscribe, and nothing else. The window URL holds a different key, which can enqueue a command for a short name and cannot pull an inbox; Chrome's command line shows it, so it stays the weakest. Subscribe returns a session token that pulls that session's inbox, acks, shows the window and ends the call. It cannot enqueue for every session.
- The agent requires signed tokens, so its id alone can't start a call.
- The ElevenLabs key stays in the hub process and never reaches the browser.
- Prompts reach Claude framed as coming from the wolfbud plugin ("The user asked WolfBud … to pass this on"), and the pane lists each one.
- If the hub is down, the Claude session keeps working. The pane says so.

## Development

```bash
claude plugin validate mods/wolfbud
npx -y -p typescript@5 tsc -p mods/wolfbud
(cd mods/wolfbud && claude plugin test)
node --test mods/wolfbud/bridge/hub.test.mjs
pnpm window:typecheck && pnpm window:build
```

The mod tests stand a fake hub beneath the plugin (`tests/wolfbud.test.tsx`); the hub test runs the real `server.mjs` with two sessions and checks that a named send lands in one inbox only. The kit can't store a plugin's `session.append`, so the mid-turn note's success path is only exercised in a real session. Its fallback (queue the prompt) is tested.
