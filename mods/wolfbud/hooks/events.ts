// What the mod, its bridge (bridge/server.mjs) and the window (window/src)
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

/** The session's facts the window shows and hands the agent. */
export type SessionInfo = { project: string; cwd: string }

/** One line the bridge writes on stdout for the mod: `WOLFBUD <json>`. */
export type BridgeMessage =
  | { t: 'ready'; port: number; hasApiKey: boolean; hasAgent: boolean; isWindowBuilt: boolean }
  | { t: 'fatal'; error: string }
  | { t: 'window'; open: boolean; count: number }
  | { t: 'status'; call: CallStatus; mode: VoiceMode | null; error?: string }
  | { t: 'line'; role: 'user' | 'agent'; text: string }
  | { t: 'snapshot' }
  | { t: 'send'; id: string; prompt: string; when: 'now' | 'after_current'; summary: string }
  | { t: 'stop'; id: string; reason: string }

/** What the mod asks of the newest window, through /api/command. */
export type WindowCommand = 'start-call' | 'end-call'
