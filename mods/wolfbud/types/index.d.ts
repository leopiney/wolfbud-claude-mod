/** The local bridge the mod spawns (bridge/server.mjs) and what it reported. */
export type WolfbudBridge = {
  status: 'off' | 'starting' | 'ready' | 'error'
  /** The port it bound, reused on a reload so an open window reconnects. */
  port: number
  /** The session key every /api route checks, kept across reloads for the same reason. */
  key: string
  error: string | null
  hasApiKey: boolean
  isWindowBuilt: boolean
  isWindowOpen: boolean
  /** The person started it and hasn't stopped it: a reload brings it back. */
  isWanted: boolean
  /** Which spawn owns the state, so a dying old bridge can't clobber a new one. */
  run: string
}

/** The voice call, as the window reports it. */
export type WolfbudCall = {
  status: 'idle' | 'connecting' | 'live' | 'error'
  mode: 'speaking' | 'listening' | null
  error: string | null
}

/** A row of the pane's transcript: what was said, and what went to Claude. */
export type WolfbudLine = {
  id: number
  role: 'user' | 'agent' | 'sent' | 'note'
  text: string
}

/** Whether Claude is mid-turn, and that turn's id (for a stop). */
export type WolfbudClaude = {
  isBusy: boolean
  turnId: string | null
}

declare module 'claude-code' {
  interface PluginState {
    wolfbud: {
      bridge: WolfbudBridge
      call: WolfbudCall
      lines: WolfbudLine[]
      claude: WolfbudClaude
    }
  }
}
