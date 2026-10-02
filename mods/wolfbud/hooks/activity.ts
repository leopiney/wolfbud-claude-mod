// Pure helpers: how Claude's activity reads to the voice agent, and how the
// bridge's stdout splits into messages. No `$` here, so tests call them bare.

import type { SessionMessage } from 'claude-code'

import type { BridgeMessage } from './events'

const BRIDGE_PREFIX = 'WOLFBUD '

/** Collapses whitespace and cuts to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** The last two segments of a path: enough to say which file, short enough to speak. */
export function shortPath(path: string): string {
  return path.split('/').filter(Boolean).slice(-2).join('/')
}

export function projectName(cwd: string): string {
  return cwd.split('/').filter(Boolean).at(-1) ?? cwd
}

function text(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  return typeof value === 'string' ? value : ''
}

/** One line saying what a tool call was about, from its name and arguments. */
export function describeTool(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'Bash':
    case 'PowerShell':
      return clip(text(input, 'description') || text(input, 'command'), 140)
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return shortPath(text(input, 'file_path') || text(input, 'notebook_path'))
    case 'Grep':
    case 'Glob':
      return clip(`${text(input, 'pattern')} ${text(input, 'path') ? `in ${shortPath(text(input, 'path'))}` : ''}`, 120)
    case 'WebFetch':
      return clip(text(input, 'url'), 120)
    case 'WebSearch':
      return clip(text(input, 'query'), 120)
    case 'Agent':
    case 'Task':
      return clip(text(input, 'description') || text(input, 'subagent_type'), 120)
    case 'Skill':
      return clip(text(input, 'skill') || text(input, 'command'), 80)
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? (input.todos as Array<Record<string, unknown>>) : []
      const active = todos.find(todo => todo.status === 'in_progress')
      const done = todos.filter(todo => todo.status === 'completed').length
      return clip(`${done}/${todos.length} done${active ? `, now: ${String(active.content ?? '')}` : ''}`, 140)
    }
    default: {
      const first = Object.values(input).find(value => typeof value === 'string' && value.length > 0)
      return typeof first === 'string' ? clip(first, 100) : ''
    }
  }
}

/** A tool's display name: `mcp__server__tool` reads as `server tool`. */
export function toolLabel(tool: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
  return mcp ? `${mcp[1]} ${mcp[2]}` : tool
}

/** The tail of an error, where test runners and compilers put their summary. */
export function errorGist(message: string | undefined): string | undefined {
  if (!message) return undefined
  const flat = message.replace(/\s+/g, ' ').trim()
  return flat.length > 280 ? `…${flat.slice(-279)}` : flat
}

const SNAPSHOT_MESSAGES = 14
const SNAPSHOT_BUDGET = 6000

/**
 * The "[session snapshot]" the agent gets as a call starts: the session's
 * latest messages, newest last, each cut short, within a fixed budget.
 */
export function formatSnapshot(
  messages: readonly SessionMessage[],
  info: { project: string; isBusy: boolean },
): string {
  const rows: string[] = []
  for (const message of messages.slice(-SNAPSHOT_MESSAGES)) {
    if (message.role === 'user') {
      // Tool results ride on user rows; they are summarized on the call that made them.
      if (message.text.trim() !== '') rows.push(`User: ${clip(message.text, 500)}`)
      continue
    }
    const steps = message.toolUses
      .map(use => {
        const detail = describeTool(use.tool, use.input)
        const mark = use.isError ? ' (failed)' : ''
        return `${toolLabel(use.tool)}${detail ? ` ${detail}` : ''}${mark}`
      })
      .join('; ')
    const said = message.text.trim() === '' ? '' : clip(message.text, 700)
    if (said || steps) rows.push(`Claude: ${said}${said && steps ? ' ' : ''}${steps ? `[steps: ${steps}]` : ''}`)
  }

  let body = rows.join('\n')
  if (body.length > SNAPSHOT_BUDGET) body = `…${body.slice(-SNAPSHOT_BUDGET)}`
  const status = info.isBusy ? 'Claude is working on a task right now.' : 'Claude is idle, waiting for the user.'
  return [
    `[session snapshot] Project: ${info.project}. ${status}`,
    body === '' ? 'Nothing has happened in this session yet.' : `Latest conversation between the user and Claude, oldest first:\n${body}`,
  ].join('\n')
}

/**
 * Splits bridge output into its `WOLFBUD <json>` messages; `rest` is a
 * trailing partial line to prepend to the next chunk. Other lines are dropped.
 */
export function splitBridgeOutput(buffer: string): { messages: BridgeMessage[]; rest: string } {
  const lines = buffer.split('\n')
  const rest = lines.pop() ?? ''
  const messages: BridgeMessage[] = []
  for (const line of lines) {
    if (!line.startsWith(BRIDGE_PREFIX)) continue
    try {
      messages.push(JSON.parse(line.slice(BRIDGE_PREFIX.length)) as BridgeMessage)
    } catch {
      // A malformed line is the bridge's bug, not a reason to stop reading.
    }
  }
  return { messages, rest }
}
