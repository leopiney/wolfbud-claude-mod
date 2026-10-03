// The WolfBud voice agent, set up in the user's own ElevenLabs account from
// the definition in ../elevenlabs (agent.json and its promptFile). Plain REST
// calls, so the bridge needs no packages: an install from GitHub runs no
// `npm install`. The bridge runs it when a call needs an agent and the one
// the mod saved is missing or came from another definition; `pnpm agent:sync`
// runs it by hand.
//
// Idempotent: client tools upsert by name, the agent is found (or created) by
// name, and an update sends only what the definition owns. The agent PATCH
// deep-merges, so a setting tried in the dashboard survives until it's
// codified here. Renaming the agent creates a new one and orphans the old.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const API = 'https://api.elevenlabs.io/v1'
const AGENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../elevenlabs')

/** The definition, its prompt, and a hash of both that tells a saved agent from a stale one. */
export function loadDefinition() {
  const text = readFileSync(resolve(AGENT_DIR, 'agent.json'), 'utf8')
  const def = JSON.parse(text)
  const prompt = readFileSync(resolve(AGENT_DIR, def.promptFile), 'utf8').trim()
  const hash = createHash('sha256').update(text).update('\0').update(prompt).digest('hex').slice(0, 12)
  return { def, prompt, hash }
}

/** The definition's camelCase keys, one level deep, as the API spells them. */
function snakeKeys(object) {
  return Object.fromEntries(
    Object.entries(object).map(([key, value]) => [key.replace(/[A-Z]/g, upper => `_${upper.toLowerCase()}`), value]),
  )
}

/** The client tools. `parameters` is a JSON schema whose property names are the window's contract, so it goes as written. */
function toolConfigs(def) {
  return def.tools.map(tool => ({ execution_mode: 'immediate', ...snakeKeys(tool) }))
}

/** What the definition owns of the agent. A PATCH replaces lists, so `clientEvents` carries the ones the agent has. */
function agentFields({ def, prompt }, toolIds, clientEvents = []) {
  const endCall = { end_call: { name: 'end_call', description: '', params: { system_tool_type: 'end_call' } } }
  return {
    name: def.name,
    conversation_config: {
      agent: {
        first_message: def.firstMessage,
        language: def.language,
        dynamic_variables: { dynamic_variable_placeholders: def.dynamicVariables },
        prompt: {
          prompt,
          llm: def.llm,
          temperature: def.temperature,
          tool_ids: toolIds,
          ...(def.endCallTool ? { built_in_tools: endCall } : {}),
        },
      },
      conversation: {
        text_only: false,
        max_duration_seconds: def.conversation.maxDurationSeconds,
        client_events: [...new Set([...clientEvents, ...def.conversation.clientEvents])],
      },
      tts: snakeKeys(def.tts),
      turn: snakeKeys(def.turn),
    },
    // Only tokens the bridge mints may start a call.
    platform_settings: { auth: { enable_auth: Boolean(def.requireSignedToken) } },
  }
}

/** What a sync sends, for `pnpm agent:sync --dry-run`. */
export function syncPlan(definition) {
  return { tools: toolConfigs(definition.def), agent: agentFields(definition, ['<tool ids>']) }
}

/** The readable part of an error body: its `detail`, or the detail's message. */
function detailOf(text) {
  try {
    const { detail } = JSON.parse(text)
    if (typeof detail === 'string') return detail
    if (typeof detail?.message === 'string') return detail.message
  } catch {}
  return text.slice(0, 200)
}

async function request(apiKey, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'xi-api-key': apiKey, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`ElevenLabs ${method} ${path.split('?')[0]} failed (${res.status}): ${detailOf(text)}`)
  return text === '' ? {} : JSON.parse(text)
}

async function listAll(apiKey, path, field) {
  const all = []
  let cursor
  do {
    const page = await request(apiKey, 'GET', `${path}?page_size=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
    all.push(...(page[field] ?? []))
    cursor = page.has_more ? page.next_cursor : undefined
  } while (cursor)
  return all
}

async function upsertTools(apiKey, def, log) {
  const existing = await listAll(apiKey, '/convai/tools', 'tools')
  const byName = new Map(existing.map(tool => [tool.tool_config?.name, tool]))
  const ids = []
  for (const config of toolConfigs(def)) {
    const found = byName.get(config.name)
    const saved = found
      ? await request(apiKey, 'PATCH', `/convai/tools/${found.id}`, { tool_config: config })
      : await request(apiKey, 'POST', '/convai/tools', { tool_config: config })
    ids.push(saved.id ?? found?.id)
    log(`${found ? 'updated' : 'created'} tool ${config.name}`)
  }
  return ids
}

/** The id of the key's agent named `name`, or undefined. */
export async function findAgentId(apiKey, name) {
  const agents = await listAll(apiKey, '/convai/agents', 'agents')
  return agents.find(agent => agent.name === name)?.agent_id
}

/** Creates or updates the agent from the definition, and returns its id. `log` gets a line per step. */
export async function syncAgent(apiKey, definition, { log = () => {} } = {}) {
  const toolIds = await upsertTools(apiKey, definition.def, log)
  const found = await findAgentId(apiKey, definition.def.name)
  if (found === undefined) {
    const created = await request(apiKey, 'POST', '/convai/agents/create', agentFields(definition, toolIds))
    log(`created agent ${created.agent_id}`)
    return created.agent_id
  }
  const current = await request(apiKey, 'GET', `/convai/agents/${found}`)
  const clientEvents = current.conversation_config?.conversation?.client_events
  await request(apiKey, 'PATCH', `/convai/agents/${found}`, agentFields(definition, toolIds, clientEvents))
  log(`updated agent ${found}`)
  return found
}
