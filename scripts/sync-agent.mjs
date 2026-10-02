// Pushes the WolfBud agent definition to ElevenLabs.
//
//   ELEVENLABS_API_KEY=… pnpm agent:sync            # sync
//   ELEVENLABS_API_KEY=… pnpm agent:sync --dry-run  # print what would be sent
//
// mods/wolfbud/elevenlabs/agent.json (+ its promptFile) is the source of
// truth. Idempotent: client tools upsert by name, the agent is found (or
// created) by name, and its id is written to agent-id.json beside the
// definition, where the mod's bridge reads it. Renaming the agent creates a
// new one on the next run and orphans the old one: delete it by hand.

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const AGENT_DIR = resolve(ROOT, 'mods/wolfbud/elevenlabs')
const DEF_FILE = resolve(AGENT_DIR, 'agent.json')
const ID_FILE = resolve(AGENT_DIR, 'agent-id.json')
const isDryRun = process.argv.includes('--dry-run')

const def = JSON.parse(readFileSync(DEF_FILE, 'utf8'))
const prompt = readFileSync(resolve(AGENT_DIR, def.promptFile), 'utf8').trim()

// The LLM mimics its prompt's punctuation, and an em dash read aloud sounds off.
for (const [where, text] of [['prompt', prompt], ['firstMessage', def.firstMessage]]) {
  if (text.includes('—')) throw new Error(`${where} contains an em dash; the agent would copy it`)
}

const tools = def.tools.map(({ type, ...config }) => ({
  toolConfig: { type, executionMode: 'immediate', ...config },
}))

function conversationConfigFor(current, toolIds) {
  // Inline prompt.tools is deprecated and output-only: it must be absent from
  // the update payload, so strip it from what we spread.
  const { tools: _inlineTools, ...promptRest } = current.agent?.prompt ?? {}
  const builtInTools = {
    ...promptRest.builtInTools,
    ...(def.endCallTool
      ? { endCall: { name: 'end_call', description: '', params: { systemToolType: 'end_call' } } }
      : {}),
  }
  return {
    ...current,
    agent: {
      ...current.agent,
      firstMessage: def.firstMessage,
      language: def.language,
      // Owned whole: spreading the current value keeps its snake_case key,
      // which wins over this one and empties the placeholders.
      dynamicVariables: { dynamicVariablePlaceholders: def.dynamicVariables },
      prompt: {
        ...promptRest,
        prompt,
        llm: def.llm,
        temperature: def.temperature,
        toolIds,
        builtInTools,
      },
    },
    conversation: {
      ...current.conversation,
      textOnly: false,
      maxDurationSeconds: def.conversation.maxDurationSeconds,
      clientEvents: [
        ...new Set([...(current.conversation?.clientEvents ?? []), ...def.conversation.clientEvents]),
      ],
    },
    // Code owns these: override over the spread so existing agents move too.
    // modelId stays out: SDK 2.70.0's enum predates eleven_v4_turbo and its
    // serializer throws on it (patchRaw sets it instead).
    tts: withoutModelId({ ...current.tts, ...def.tts }),
    turn: { ...current.turn, ...def.turn },
  }
}

function withoutModelId({ modelId: _modelId, ...rest }) {
  return rest
}

function platformSettingsFor(current) {
  return {
    ...current,
    // The agent id sits in git, so only tokens the bridge mints may start a call.
    auth: { ...current?.auth, enableAuth: Boolean(def.requireSignedToken) },
  }
}

if (isDryRun) {
  console.log(JSON.stringify({
    name: def.name,
    tools,
    conversationConfig: conversationConfigFor({}, ['<tool ids>']),
    platformSettings: platformSettingsFor({}),
  }, null, 2))
  process.exit(0)
}

const apiKey = process.env.ELEVENLABS_API_KEY
if (!apiKey) {
  console.error('ELEVENLABS_API_KEY is not set.')
  process.exit(1)
}
const client = new ElevenLabsClient({ apiKey })

async function listAll(fetchPage, pick) {
  const all = []
  let cursor
  do {
    const page = await fetchPage(cursor)
    all.push(...pick(page))
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return all
}

async function upsertTools() {
  const existing = await listAll(
    cursor => client.conversationalAi.tools.list({ pageSize: 100, cursor }),
    page => page.tools ?? [],
  )
  const byName = new Map(existing.map(tool => [tool.toolConfig?.name, tool]))
  const ids = []
  for (const tool of tools) {
    const name = tool.toolConfig.name
    const found = byName.get(name)
    const saved = found
      ? await client.conversationalAi.tools.update(found.id, tool)
      : await client.conversationalAi.tools.create(tool)
    ids.push(saved.id)
    console.log(`  ${found ? 'updated' : 'created'} tool ${name}`)
  }
  return ids
}

async function findAgentId() {
  const agents = await listAll(
    cursor => client.conversationalAi.agents.list({ pageSize: 100, cursor }),
    page => page.agents ?? [],
  )
  return agents.find(agent => agent.name === def.name)?.agentId
}

// What SDK 2.70.0 can't send, set with a raw request after its update (the
// agent PATCH endpoint deep-merges, so only these leaves change):
// - the TTS model: its enum predates eleven_v4_turbo, so the serializer throws;
// - the dynamic variable placeholders: the SDK update leaves them empty, and
//   without them a dashboard test or a simulation fails on {{project_name}}.
async function patchRaw(agentId) {
  const res = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${agentId}`, {
    method: 'PATCH',
    headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      conversation_config: {
        agent: { dynamic_variables: { dynamic_variable_placeholders: def.dynamicVariables } },
        tts: { model_id: def.tts.modelId },
      },
    }),
  })
  if (!res.ok) throw new Error(`raw PATCH failed (${res.status}): ${await res.text()}`)
}

async function main() {
  console.log(`Syncing "${def.name}"`)
  const toolIds = await upsertTools()

  let agentId = await findAgentId()
  if (!agentId) {
    const created = await client.conversationalAi.agents.create({
      name: def.name,
      conversationConfig: conversationConfigFor({}, toolIds),
      platformSettings: platformSettingsFor({}),
    })
    agentId = created.agentId
    console.log(`  created agent ${agentId}`)
  }

  // Spread what the agent has now and override only what this repo owns, so a
  // setting tried in the dashboard survives until it is codified here.
  const agent = await client.conversationalAi.agents.get(agentId)
  await client.conversationalAi.agents.update(agentId, {
    name: def.name,
    conversationConfig: conversationConfigFor(agent.conversationConfig ?? {}, toolIds),
    platformSettings: platformSettingsFor(agent.platformSettings ?? {}),
  })

  await patchRaw(agentId)

  writeFileSync(ID_FILE, `${JSON.stringify({ name: def.name, agentId }, null, 2)}\n`)
  console.log(`  synced ${agentId} (${toolIds.length} tools), id written to ${ID_FILE.replace(`${ROOT}/`, '')}`)
}

main().catch(error => {
  console.error(error?.body ?? error)
  process.exit(1)
})
