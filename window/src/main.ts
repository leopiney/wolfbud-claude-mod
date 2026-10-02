// The WolfBud window: the wolf, the call, and the feed of what Claude is doing.
// Opened by the wolfbud mod (/wolfbud) at http://127.0.0.1:<port>/#k=<key>.

import './style.css'

import type { ClaudeEvent, SessionInfo } from '../../mods/wolfbud/hooks/events'
import { Bridge, readLaunch } from './bridge'
import { WolfCall } from './call'
import { activityAnswer, activityUpdate, feedLine, promptUpdate, quietEvent, spokenEvent } from './context'
import { createWolf } from './wolf'
import type { Wolf } from './wolf'

const RECENT_LIMIT = 150
const LOST_BRIDGE_MS = 20_000
const ANNOUNCE_KEY = 'wolfbud.announce'
const BADGE_MAX = 236
const BADGE_MIN = 64
const RING_OUTSET = 7

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const app = $('app')
const stage = $('stage')
const statusText = $('status')
const claudeText = $('claude-status')
const agentCaption = $('caption-agent')
const userCaption = $('caption-user')
const feed = $('feed')
const callButton = $<HTMLButtonElement>('call')
const muteButton = $<HTMLButtonElement>('mute')
const announceBox = $<HTMLInputElement>('announce')
const overlay = $('overlay')
const overlayText = $('overlay-text')

const events: ClaudeEvent[] = []
let session: Partial<SessionInfo> = {}
let isClaudeBusy = false
let snapshot = ''
let busySince = 0
let wolf: Wolf | null = null
let lostAt: number | null = null
let activityTimer: number | null = null
let badgeSize = BADGE_MAX

function readAnnounce(): boolean {
  try {
    return localStorage.getItem(ANNOUNCE_KEY) !== 'off'
  } catch {
    return true
  }
}

announceBox.checked = readAnnounce()
announceBox.addEventListener('change', () => {
  try {
    localStorage.setItem(ANNOUNCE_KEY, announceBox.checked ? 'on' : 'off')
  } catch {}
})

function showOverlay(text: string | null): void {
  overlay.hidden = text === null
  overlayText.textContent = text ?? ''
}

const launch = readLaunch()
if (launch.key === '') {
  showOverlay('Open WolfBud from Claude Code: type /wolfbud in a session that loads the wolfbud mod.')
  throw new Error('no session key in the URL')
}

const bridge = new Bridge(launch.key, {
  hello(hello) {
    events.splice(0, events.length, ...hello.recent)
    session = hello.session
    setBusy(hello.isClaudeBusy)
    renderFeed()
  },
  claude(event) {
    events.push(event)
    events.splice(0, Math.max(0, events.length - RECENT_LIMIT))
    if (event.kind === 'turn-start') setBusy(true)
    if (event.kind === 'turn-complete') setBusy(false)
    renderFeed()
    tellAgent(event)
  },
  snapshot(text) {
    snapshot = text
    call.context(text, 'session_snapshot')
  },
  session(next) {
    session = next
  },
  busy(isBusy) {
    setBusy(isBusy)
  },
  command(cmd) {
    if (cmd === 'start-call') void call.start()
    if (cmd === 'end-call') void call.end()
    if (cmd === 'superseded') {
      void call.end()
      bridge.close()
      showOverlay('WolfBud moved to a newer window. You can close this one.')
      // An app window opened from the command line may close itself; elsewhere the overlay stays.
      window.setTimeout(() => window.close(), 300)
    }
  },
  connection(isConnected) {
    if (isConnected) {
      lostAt = null
      showOverlay(null)
      // A reload of the mod restarts the bridge: tell it where the call stands.
      bridge.status(call.status, call.isLive ? call.mode : null)
      return
    }
    lostAt ??= Date.now()
    showOverlay('Lost Claude Code. Reconnecting…')
  },
})

const call = new WolfCall({
  bridge,
  dynamicVariables: () => ({ project_name: session.project ?? 'the current project' }),
  activity: focus => activityAnswer(focus, events, isClaudeBusy, snapshot),
  connected() {
    // Orient the agent: the rolling activity now, the transcript as soon as the mod sends it.
    call.context(activityUpdate(events, isClaudeBusy), 'claude_activity')
    bridge.requestSnapshot()
  },
  view: {
    status(status, error) {
      app.dataset.call = status
      callButton.textContent = status === 'live' || status === 'connecting' ? 'End call' : 'Call WolfBud'
      callButton.classList.toggle('primary', status !== 'live' && status !== 'connecting')
      muteButton.disabled = status !== 'live'
      if (status !== 'live') {
        muteButton.classList.remove('muted')
        agentCaption.textContent = ''
        userCaption.textContent = ''
      }
      statusText.textContent =
        status === 'connecting' ? 'Calling…'
          : status === 'live' ? 'Listening'
            : status === 'error' ? (error ?? 'The call failed')
              : 'Not on a call'
      wolf?.mood(status === 'live' ? 'listening' : status === 'connecting' ? 'awake' : 'asleep')
    },
    mode(mode) {
      app.dataset.mode = mode
      if (call.status === 'live') statusText.textContent = mode === 'speaking' ? 'Talking' : 'Listening'
      wolf?.mood(mode === 'speaking' ? 'speaking' : 'listening')
    },
    agentLine(text) {
      agentCaption.textContent = text
    },
    userLine(text) {
      userCaption.textContent = text
    },
    userSpeaking(isSpeaking) {
      app.dataset.hearing = isSpeaking ? 'yes' : 'no'
    },
  },
})

function setBusy(isBusy: boolean): void {
  if (isBusy && !isClaudeBusy) busySince = Date.now()
  isClaudeBusy = isBusy
  app.dataset.claude = isBusy ? 'busy' : 'idle'
  renderClaudeChip()
}

function renderClaudeChip(): void {
  if (!isClaudeBusy) {
    claudeText.textContent = 'Claude is idle'
    return
  }
  const s = Math.round((Date.now() - busySince) / 1000)
  claudeText.textContent = `Claude is working · ${s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`}`
}

function renderFeed(): void {
  const rows = events
    .map(feedLine)
    .filter((line): line is NonNullable<typeof line> => line !== null)
    .slice(-5)
  feed.replaceChildren(
    ...rows.map(row => {
      const item = document.createElement('li')
      item.className = `feed-${row.tone}`
      const icon = document.createElement('span')
      icon.className = 'feed-icon'
      icon.textContent = row.icon
      const text = document.createElement('span')
      text.className = 'feed-text'
      text.textContent = row.text
      item.append(icon, text)
      return item
    }),
  )
}

/** Hands the agent each event: spoken when it matters (and announcements are on), quiet context otherwise. */
function tellAgent(event: ClaudeEvent): void {
  if (!call.isLive) return
  if (event.kind === 'prompt') {
    const update = promptUpdate(event)
    if (update !== null) call.context(update)
  }
  const spoken = spokenEvent(event)
  if (spoken !== null && announceBox.checked) {
    call.announce(spoken, event.kind)
  } else {
    const quiet = quietEvent(event)
    if (quiet !== null) call.context(quiet)
  }
  // Steps arrive in bursts: one rolling update per burst, under one id.
  if (activityTimer !== null) window.clearTimeout(activityTimer)
  activityTimer = window.setTimeout(() => {
    activityTimer = null
    call.context(activityUpdate(events, isClaudeBusy), 'claude_activity')
  }, 2500)
}

callButton.addEventListener('click', () => {
  if (call.status === 'live' || call.status === 'connecting') void call.end()
  else void call.start()
})
muteButton.addEventListener('click', () => {
  const isMuted = call.toggleMute()
  muteButton.classList.toggle('muted', isMuted)
  muteButton.title = isMuted ? 'Unmute' : 'Mute'
})
$('badge').addEventListener('click', () => wolf?.pet())

// Captions and feed rows wrap and take the rows they need: the wolf shrinks into what's
// left, and steps aside while even the smallest wolf won't fit.
function fitBadge(): void {
  const gap = parseFloat(getComputedStyle(stage).rowGap) || 0
  const tall = stage.clientHeight - statusText.offsetHeight - gap - 2 * RING_OUTSET
  const wide = stage.clientWidth - 2 * RING_OUTSET
  const size = Math.floor(Math.min(BADGE_MAX, tall, wide))
  app.dataset.wolf = size < BADGE_MIN ? 'hidden' : 'shown'
  if (size < BADGE_MIN || size === badgeSize) return
  badgeSize = size
  app.style.setProperty('--badge', `${size}px`)
  wolf?.resize(size - 16)
}

const fitObserver = new ResizeObserver(fitBadge)
fitObserver.observe(stage)
fitObserver.observe(statusText)

// The wolf follows the call: jaw on the agent's voice, tilt on the user's.
function animate(): void {
  requestAnimationFrame(animate)
  const isTalking = call.isLive && call.mode === 'speaking'
  wolf?.voice(isTalking, Math.min(1, call.outputLevel() * 2.2))
  wolf?.hear(Math.min(1, call.inputLevel() * 6))
}

window.setInterval(() => {
  if (isClaudeBusy) renderClaudeChip()
  // The mod's gone for good (session over), not just reloading: hang up.
  if (lostAt !== null && Date.now() - lostAt > LOST_BRIDGE_MS && call.status !== 'idle') {
    void call.end()
    showOverlay('Claude Code went away, so the call ended. Reopen WolfBud with /wolfbud.')
  }
}, 1000)

window.addEventListener('beforeunload', () => {
  void call.end()
})

void createWolf($('wolf'), './wolf-head.glb', badgeSize - 16).then(created => {
  wolf = created
  wolf?.resize(badgeSize - 16)
  wolf?.mood('asleep')
  animate()
})

bridge.connect()
if (launch.wantsCall) {
  // Drop &call=1 so a reload doesn't call again.
  history.replaceState(null, '', `#k=${encodeURIComponent(launch.key)}`)
  void call.start()
}
