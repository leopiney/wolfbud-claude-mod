// Pure helpers: how Claude's activity reads to the voice agent, how the
// bridge's stdout splits into messages, and how the pane's transcript fits its
// rows. No `$` here, so tests call them bare.

import type { SessionMessage } from 'claude-code'

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
  info: { project: string; isBusy: boolean; name?: string },
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
  const who = info.name ? `Session ${info.name}. ` : ''
  return [
    `[session snapshot] ${who}Project: ${info.project}. ${status}`,
    body === '' ? 'Nothing has happened in this session yet.' : `Latest conversation between the user and Claude, oldest first:\n${body}`,
  ].join('\n')
}

/**
 * Rows `text` takes on the terminal wrapped at `width` cells: whole words while
 * they fit, a word wider than a row broken across rows. Counts code points, so
 * it reads a wide glyph as one cell.
 */
export function wrappedRows(text: string, width: number): number {
  const cols = Math.max(1, Math.floor(width))
  let rows = 0
  for (const paragraph of text.split('\n')) {
    rows += 1
    let used = 0
    for (const word of paragraph.split(' ')) {
      const cells = [...word].length
      if (used > 0 && used + 1 + cells <= cols) {
        used += 1 + cells
        continue
      }
      if (used > 0) rows += 1
      const spill = Math.max(0, Math.ceil(cells / cols) - 1)
      rows += spill
      used = cells - spill * cols
    }
  }
  return rows
}

/**
 * The newest items that fit in `rows`, oldest dropped first, as a log pinned to
 * its bottom shows them. When even the newest is taller, it alone, its text cut
 * from the front (see `tailText`).
 */
export function fitTail<T extends { text: string }>(items: readonly T[], rows: number, width: number): T[] {
  const shown: T[] = []
  let used = 0
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!
    const height = wrappedRows(item.text, width)
    if (used + height > rows) {
      if (shown.length === 0) shown.push({ ...item, text: tailText(item.text, rows, width) })
      break
    }
    shown.unshift(item)
    used += height
  }
  return shown
}

/** `text` cut from the front, behind an ellipsis, until it wraps into `rows` rows of `width` cells. */
export function tailText(text: string, rows: number, width: number): string {
  if (wrappedRows(text, width) <= rows) return text
  const chars = [...text]
  for (let keep = Math.max(1, rows * Math.max(1, Math.floor(width)) - 1); keep > 0; keep -= 1) {
    const tail = `…${chars.slice(-keep).join('').trimStart()}`
    if (wrappedRows(tail, width) <= rows) return tail
  }
  return '…'
}
