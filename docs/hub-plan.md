# WolfBud hub

2026-10-06

One floating Chrome window. `/wolfbud` subscribes the current Claude session to it. Many Claude sessions can run under that one voice at the same time.

## What stays in Claude

Claude only lets a mod inside that session see the work and put a prompt back. `prompt.submit`, `session.append`, and `turn.abort` in `mods/wolfbud/hooks/register.tsx` have no equivalent from outside. The window cannot grow those hands.

Before the hub, each session spawned its own `bridge/server.mjs`. Claude kills that child on unload, and the server also exited when its parent died. A second session found port 4747 taken and opened another bridge, another window, and another call. A send from the window was written to that bridge's stdout, and only the mod that spawned it ran `deliver()`. Pointing a second session at the first bridge could not land a prompt in the second session.

So the mod stays. It is a subscriber. The bridge is one service that outlives any session. The window is the face.

```text
Chrome window   the face: roster, wolf, one call
hub             the switchboard: roster, inboxes, tokens
Claude mod      the hands: hooks and deliver() for that session only
```

## One service, one window

The service is `bridge/server.mjs` on a fixed `127.0.0.1:4747`, serving the window you already have. It is not a child of any Claude session. The mic grant is per origin, so the port does not walk the way 4747 did before.

Orca and terminal-browser are not places to open the wolf. One Google Chrome app window is the only face: its own profile at `~/.wolfbud/chrome`, `--app` pointed at the hub, and `--autoplay-policy=no-user-gesture-required` so a call can start without a click. That is a separate Chrome from the user's normal one. `open -n` on every `/wolfbud` would start another instance, so the hub opens it once. Later subscriptions only raise it.

The hub ignores SIGHUP, so the launcher's exit does not take it down. It is never started with `$.process.spawn`. Claude kills those children.

The first `/wolfbud` that finds the service down runs `bridge/launch.mjs` and waits for `/api/health`. The launcher spawns `node server.mjs` with `detached: true` (a new session), waits for health, and exits. It owns nothing else. The server mints its service token and window key (or reuses the saved ones) and writes `~/.wolfbud/hub.json` as it starts listening; a second server that finds the port taken exits quietly, so two launchers racing is harmless. The window URL gets a separate key. A session token is not the key that can enqueue commands for every session.

The ElevenLabs key is not frozen at launch. Each subscription carries the key its session has (the `api_key` option, else `ELEVENLABS_API_KEY`), and the hub keeps the first non-empty one it is handed. A session with a key repairs a hub that was started without one; nothing has to restart.

## Subscribe on `/wolfbud`

`/wolfbud` is a subscription, not a new wolf.

1. Reuse the session id in `$.state`, or mint one. A reload must keep it.
2. `POST /api/subscribe` with the service token, the project name, whether Claude is busy, and the API key. The hub adds a row and a short name (`auth`, `auth-2`) and answers with a session token.
3. Start a `$.clock` loop that long-polls that session's inbox, and keep posting the events the hooks already report.
4. Ask the hub to show the window. The hub runs `open -na Google Chrome` only when no window is connected.

A later `/wolfbud` in a session that is already subscribed skips to step 4. The poll re-subscribes on its own when the hub answers 401, which is how a hub that restarted gets its roster back.

`/wolfbud call` focuses this subscription and starts the one call if it is not already live. `/wolfbud end` hangs up that one call. It does not drop the other subscriptions. `/wolfbud stop` unsubscribes this session only. `session.end` does the same. Another Claude's wolf stays up.

If the service is down, the session keeps working and the pane says so.

## Two directions

The hub never calls Claude. It talks only to the mod already inside a session. The session token is the routing key. The injection still happens in `deliver()`, which already exists.

```text
session A                         hub                         window / voice
    |                              |                              |
    |  subscribe                   |                              |
    |----------------------------->|  roster                      |
    |                              |----------------------------->|
    |  events, snapshot            |                              |
    |----------------------------->|  SSE                         |
    |                              |----------------------------->|
    |                              |  "tell auth to add a test"   |
    |                              |<-----------------------------|
    |  poll: send cmd_18           |                              |
    |<-----------------------------|                              |
    |  $.prompt.submit / append    |                              |
    |  ack cmd_18                  |                              |
    |----------------------------->|  tool result                 |
    |                              |----------------------------->|
```

### Up: the session tells the hub

After subscribe, the hooks that already call `report()` queue the same `ClaudeEvent`s; one `POST /api/session/events` carries each burst once the hook has returned, so a tool call never waits on the hub. The hub reads busy from `turn-start` and `turn-complete`. A snapshot is the same post, from `$.session.messages()`, when the hub asks for one. `session.end` sends bye, and the hub drops the row.

The window does not talk to a session. It subscribes to the hub over SSE. On connect it gets the roster with each row's recent events; after that each event names its session, and the roster says who is focused and who is busy.

### Down: the hub tells one session

The mod cannot listen. It has `$.http.fetch`, not a socket. The poll is:

```text
GET /api/session/commands      (x-wolfbud-session: <token>)
```

The hub keeps one queue per session. A command sits there until the matching mod pulls it. A webpage that guesses a session gets nothing: the pull needs the token from subscribe. The same token shows the window, ends the call, acks, and says bye; the service token is used once, to subscribe.

Every pull also carries the facts as they stand: the call's state and whether the window is open. Those are not queued, so a session that reloads sees the present, not a replay. Only what was said on the call is queued, as lines for the pane.

The voice agent does not invent a session id. The hub shows the short names. "Tell auth to add a test" resolves to that row and enqueues:

```json
{ "id": "cmd_18", "type": "send", "prompt": "Add a test for …", "when": "after_current" }
```

`when` is the choice WolfBud already makes. The mod runs it with the same calls `deliver()` uses now:

| Command                     | What the mod calls                                                                                                          |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| send, Claude idle           | `$.prompt.submit`. Starts a turn.                                                                                           |
| send, busy, `after_current` | `$.prompt.submit`. Claude queues it until the turn ends.                                                                    |
| send, busy, `now`           | `$.session.append`. A user note the running turn reads at its next step. If Claude refuses, fall back to submit, as before. |
| stop                        | `$.turn.abort({ turnId })`, using the turn id the hooks already store.                                                      |
| snapshot                    | `$.session.messages()`, posted back. No model turn, no ack.                                                                 |

Then the mod posts the ack for `cmd_18`. The voice tool waits on that ack, the way the bridge's pending map did. The tool result is "Sent: Claude is starting on it now" or the failure, not a guess.

## One voice, many Claudes

Every subscribed Claude keeps working. The one voice can send to any of them, including several in one conversation, and each `deliver()` runs in the matching session. A second session that needs you becomes a badge, or a `[session event]` on the call already live.

That is not a second floating wolf, and not a second ElevenLabs call, per Claude. Two calls in one window talk over each other.

The agent definition stays one agent in the user's account. The tools take a short session name and default to the focused session. `wolfbud_send_to_claude` remains that default. The prompt no longer assumes a single project.

The thing built is two Claude sessions, one Chrome window, and a prompt that lands in the session you named. `bridge/hub.test.mjs` pins it.
