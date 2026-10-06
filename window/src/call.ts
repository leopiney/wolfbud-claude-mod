// The voice call with the WolfBud agent (mods/wolfbud/elevenlabs/agent.json).
//
// Its client tools are the agent's hands: names must match agent.json's. What
// the agent hears about Claude arrives two ways: contextual updates (quiet:
// folded in, never answered) and "[claude event]" user messages (the agent
// says something). The second kind waits for a gap in the conversation, so
// WolfBud never talks over the user or itself.

import { Conversation } from '@elevenlabs/client'
import type { VoiceConversation } from '@elevenlabs/client'

import type { CallStatus, VoiceMode } from '../../mods/wolfbud/hooks/events'
import type { Bridge } from './bridge'
import type { ActivityFocus } from './context'

export type CallView = {
  status(status: CallStatus, error?: string): void
  mode(mode: VoiceMode): void
  /** The agent's words: tentative as it starts speaking, then final (or corrected after an interruption). */
  agentLine(text: string, isFinal: boolean): void
  userLine(text: string): void
  userSpeaking(isSpeaking: boolean): void
}

export type CallDeps = {
  bridge: Bridge
  view: CallView
  dynamicVariables(): Record<string, string>
  activity(focus: ActivityFocus, session: string | null): string
  /** The call is up: time to hand the agent its context. */
  connected(): void
}

const VAD_SPEAKING = 0.5
const USER_HOLD_MS = 1500
const ANNOUNCE_GAP_MS = 6000
const ANNOUNCE_STALE_MS = 90_000
const HEARTBEAT_MS = 25_000
const PROMISE = /\b(?:one (?:sec|second|moment)|let me (?:send|tell|pass|ask|check|look|pull)|i'?ll (?:send|tell|pass|ask|let claude)|sending (?:that|it)|passing (?:that|it))\b/i
const NUDGE = '[continue] You said you would do something but did not call the tool. Call it now and carry on from its result.'
const JUNK = /^[\s.…·,!?-]*$/
/** Eleven v4's audio tags ("[laughing]") steer the voice; they're not words to show. */
const AUDIO_TAG = /\[[^\]\n]{1,40}\]/g

function shown(text: string): string {
  return text.replace(AUDIO_TAG, '').replace(/\s{2,}/g, ' ').trim()
}

type Announcement = { text: string; kind: string; at: number }

export class WolfCall {
  private conversation: VoiceConversation | null = null
  private state: CallStatus = 'idle'
  private voiceMode: VoiceMode = 'listening'
  private isMuted = false
  private lastUserVoiceAt = 0
  private lastMessageAt = 0
  private lastToolAt = 0
  private lastNudgeAt = 0
  private queue: Announcement[] = []
  private timers: number[] = []
  private watchdog: number | null = null

  constructor(private readonly deps: CallDeps) {}

  get status(): CallStatus {
    return this.state
  }

  get mode(): VoiceMode {
    return this.voiceMode
  }

  get isLive(): boolean {
    return this.state === 'live' && this.conversation !== null
  }

  /** 0..1, for the wolf's jaw. */
  outputLevel(): number {
    return this.isLive ? (this.conversation?.getOutputVolume() ?? 0) : 0
  }

  /** 0..1, for the wolf's listening tilt. */
  inputLevel(): number {
    return this.isLive && !this.isMuted ? (this.conversation?.getInputVolume() ?? 0) : 0
  }

  private setStatus(status: CallStatus, error?: string): void {
    this.state = status
    this.deps.view.status(status, error)
    this.deps.bridge.status(status, status === 'live' ? this.voiceMode : null, error)
  }

  async start(): Promise<void> {
    if (this.state === 'connecting' || this.state === 'live') return
    this.setStatus('connecting')

    // The mic grant has to exist before the WebRTC session is built, or it
    // connects and never hears the user.
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      for (const track of stream.getTracks()) track.stop()
    } catch {
      this.setStatus('error', 'WolfBud needs the microphone: allow it for this window, then call again.')
      return
    }

    let conversationToken: string
    try {
      conversationToken = await this.deps.bridge.token()
    } catch (error) {
      this.setStatus('error', error instanceof Error ? error.message : String(error))
      return
    }

    try {
      this.conversation = (await Conversation.startSession({
        conversationToken,
        connectionType: 'webrtc',
        dynamicVariables: this.deps.dynamicVariables(),
        clientTools: this.tools(),
        onConnect: () => this.onConnected(),
        onDisconnect: details => {
          const error = details.reason === 'error' ? details.message : undefined
          this.cleanUp()
          this.setStatus(error ? 'error' : 'idle', error)
        },
        onError: message => console.warn('[call]', message),
        onModeChange: ({ mode }) => {
          this.voiceMode = mode
          this.deps.view.mode(mode)
          if (this.state === 'live') this.deps.bridge.status('live', mode)
        },
        onMessage: ({ role, message: raw }) => {
          const message = role === 'agent' ? shown(raw) : raw
          if (JUNK.test(message)) return
          if (role === 'user') {
            this.lastUserVoiceAt = Date.now()
            this.clearWatchdog()
            this.deps.view.userLine(message)
            this.deps.bridge.line('user', message)
          } else {
            this.deps.view.agentLine(message, true)
            this.deps.bridge.line('agent', message)
            this.armWatchdog(message)
          }
        },
        onDebug: (event: { type?: string; response?: string }) => {
          const text = event.type === 'tentative_agent_response' && event.response ? shown(event.response) : ''
          if (text !== '' && !JUNK.test(text)) this.deps.view.agentLine(text, false)
        },
        onAgentResponseCorrection: ({ corrected_agent_response: raw }) => {
          const corrected = shown(raw)
          if (!JUNK.test(corrected)) this.deps.view.agentLine(corrected, true)
        },
        onVadScore: ({ vadScore }) => {
          if (vadScore >= VAD_SPEAKING) this.lastUserVoiceAt = Date.now()
        },
      })) as VoiceConversation
    } catch (error) {
      this.cleanUp()
      this.setStatus('error', `Couldn't start the call: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async end(): Promise<void> {
    const conversation = this.conversation
    if (conversation === null) {
      if (this.state !== 'idle') this.setStatus('idle')
      return
    }
    this.cleanUp()
    await conversation.endSession().catch(() => undefined)
    this.setStatus('idle')
  }

  toggleMute(): boolean {
    this.isMuted = !this.isMuted
    this.conversation?.setMicMuted(this.isMuted)
    return this.isMuted
  }

  /** Quiet context: the agent folds it in and doesn't answer. With an id, it replaces the last one under that id. */
  context(text: string, contextId?: string): void {
    if (!this.isLive) return
    try {
      this.conversation?.sendContextualUpdate(text, contextId ? { contextId } : undefined)
    } catch (error) {
      console.warn('[call] context update failed', error)
    }
  }

  /** Something the agent should say, once there's a gap. A newer one of the same kind replaces a waiting one. */
  announce(text: string, kind: string): void {
    if (!this.isLive) return
    this.queue = this.queue.filter(item => item.kind !== kind)
    this.queue.push({ text, kind, at: Date.now() })
  }

  private onConnected(): void {
    this.voiceMode = 'speaking'
    this.setStatus('live')
    this.lastMessageAt = Date.now()
    this.timers.push(window.setInterval(() => this.drain(), 500))
    this.timers.push(window.setInterval(() => this.heartbeat(), 5000))
    this.deps.connected()
  }

  private isUserSpeaking(): boolean {
    return Date.now() - this.lastUserVoiceAt < USER_HOLD_MS
  }

  private drain(): void {
    this.deps.view.userSpeaking(this.isUserSpeaking())
    const now = Date.now()
    this.queue = this.queue.filter(item => now - item.at < ANNOUNCE_STALE_MS)
    if (!this.isLive || this.queue.length === 0) return
    if (this.voiceMode === 'speaking' || this.isUserSpeaking() || now - this.lastMessageAt < ANNOUNCE_GAP_MS) return
    const next = this.queue.shift()
    if (next === undefined) return
    this.lastMessageAt = now
    this.conversation?.sendUserMessage(next.text)
  }

  /** Long silences are the norm on this call; activity keeps the agent from checking in. */
  private heartbeat(): void {
    if (!this.isLive || this.voiceMode === 'speaking' || this.isUserSpeaking()) return
    const now = Date.now()
    if (now - this.lastMessageAt < HEARTBEAT_MS) return
    this.lastMessageAt = now
    this.conversation?.sendUserActivity()
  }

  /** "Let me send that to Claude" with no tool call after it freezes a voice agent: nudge it once. */
  private armWatchdog(said: string): void {
    this.clearWatchdog()
    if (!PROMISE.test(said)) return
    const saidAt = Date.now()
    const check = () => {
      if (!this.isLive || this.lastToolAt > saidAt || this.isUserSpeaking()) return
      if (this.voiceMode === 'speaking') {
        this.watchdog = window.setTimeout(check, 2000)
        return
      }
      if (Date.now() - this.lastNudgeAt < 15_000) return
      this.lastNudgeAt = Date.now()
      this.lastMessageAt = Date.now()
      this.conversation?.sendUserMessage(NUDGE)
    }
    this.watchdog = window.setTimeout(check, 5000)
  }

  private clearWatchdog(): void {
    if (this.watchdog !== null) window.clearTimeout(this.watchdog)
    this.watchdog = null
  }

  private cleanUp(): void {
    for (const timer of this.timers) window.clearInterval(timer)
    this.timers = []
    this.clearWatchdog()
    this.queue = []
    this.conversation = null
    this.deps.view.userSpeaking(false)
  }

  /** Keys are the tool names in agent.json: the whole contract with the agent. */
  private tools(): Record<string, (parameters: Record<string, unknown>) => Promise<string> | string> {
    const touch = () => {
      this.lastToolAt = Date.now()
      this.clearWatchdog()
    }
    return {
      wolfbud_send_to_claude: async parameters => {
        touch()
        const prompt = String(parameters.prompt ?? '').trim()
        if (prompt === '') return 'No prompt given: say what Claude should do in `prompt`.'
        const session = String(parameters.session ?? '').trim()
        return this.deps.bridge.ask({
          type: 'send',
          prompt,
          when: parameters.when === 'now' ? 'now' : 'after_current',
          summary: String(parameters.summary ?? ''),
          ...(session !== '' ? { session } : {}),
        })
      },
      wolfbud_stop_claude: async parameters => {
        touch()
        const session = String(parameters.session ?? '').trim()
        return this.deps.bridge.ask({
          type: 'stop',
          reason: String(parameters.reason ?? ''),
          ...(session !== '' ? { session } : {}),
        })
      },
      wolfbud_claude_activity: parameters => {
        touch()
        const focus = ['last_answer', 'recent_steps', 'errors', 'overview'].includes(String(parameters.focus))
          ? (String(parameters.focus) as ActivityFocus)
          : 'overview'
        const session = String(parameters.session ?? '').trim()
        return this.deps.activity(focus, session === '' ? null : session)
      },
    }
  }
}
