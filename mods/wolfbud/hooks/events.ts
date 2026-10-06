// What the mod, the hub (bridge/server.mjs) and the window (window/src)
// say to each other. Plain types with no imports, so the window imports them
// too and the three halves can't drift.

export type CallStatus = 'idle' | 'connecting' | 'live' | 'error'

export type VoiceMode = 'speaking' | 'listening'

/** One thing that happened in the Claude Code session, as the window hears it. */
export type ClaudeEvent =
  | { kind: 'prompt'; at: number; text: string; from: 'user' | 'wolfbud' }
  | { kind: 'turn-start'; at: number }
  | {
      kind: 'tool'
      at: number
      tool: string
      detail: string
      status: 'ok' | 'error' | 'denied'
      error?: string
      isSubagent?: true
    }
  | {
      kind: 'turn-complete'
      at: number
      answer: string
      reason: 'answer' | 'aborted' | 'refusal' | 'error'
      durationMs: number
    }
  | { kind: 'notification'; at: number; message: string; type: string }

/** One subscribed Claude, as the window's roster draws it. */
export type RosterRow = {
  id: string
  name: string
  project: string
  isBusy: boolean
  badge: number
}

/** A command the hub holds until the matching mod pulls it. */
export type HubCommand =
  | { id: string; type: 'send'; prompt: string; when: 'now' | 'after_current'; summary: string }
  | { id: string; type: 'stop'; reason: string }
  | { id: string; type: 'snapshot' }

/** Something said on the call, queued for every subscribed pane. */
export type HubLine = { role: 'user' | 'agent'; text: string }

/** The one call, as the window last reported it. */
export type HubCall = { status: CallStatus; mode: VoiceMode | null; error: string | null }

/** What a pull of a session's inbox answers: its queue, plus the facts as they stand now. */
export type PullResponse = {
  commands: HubCommand[]
  lines: HubLine[]
  call: HubCall
  isWindowOpen: boolean
}

/** What the hub asks of the window, over SSE. */
export type WindowCommand = 'start-call' | 'end-call' | 'raise' | 'superseded'
