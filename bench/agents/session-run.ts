import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk'

import type { ModelRef } from './args'
import { reduceMessagesToRunRecord, type SdkMessage } from './reducer'
import type { RunRecord, TaskSpec } from './types'

export const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error: Error & { timedOut?: boolean } = new Error(`${label} timed out after ${timeoutMs}ms`)
      error.timedOut = true
      reject(error)
    }, timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
  }
}

const extractErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  if (typeof error === 'string') {
    return error
  }
  return JSON.stringify(error)
}

export const textFromParts = (parts: readonly unknown[]): string =>
  parts
    .filter(
      (part): part is { type: 'text'; text: string; synthetic?: boolean } =>
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string' &&
        (part as { synthetic?: unknown }).synthetic !== true,
    )
    .map((part) => part.text)
    .join('\n')

const hasCompaction = (messages: readonly SdkMessage[]): boolean =>
  messages.some((message) =>
    message.parts.some(
      (part) => typeof part === 'object' && part !== null && (part as { type?: unknown }).type === 'compaction',
    ),
  )

export interface RunRepOptions {
  readonly client: OpencodeClient
  readonly directory: string
  readonly task: TaskSpec
  readonly arm: 'with' | 'without'
  readonly rep: number
  readonly agentModel: ModelRef
  readonly turnTimeoutMs: number
}

interface TurnResult {
  readonly answer: string
  readonly error: string | null
}

const sendTurn = async (
  client: OpencodeClient,
  sessionId: string,
  task: TaskSpec,
  arm: 'with' | 'without',
  rep: number,
  agentModel: ModelRef,
  turnTimeoutMs: number,
): Promise<TurnResult> => {
  try {
    const promptResult = await withTimeout(
      client.session.prompt({
        path: { id: sessionId },
        body: {
          model: { providerID: agentModel.providerID, modelID: agentModel.modelID },
          parts: [{ type: 'text', text: task.prompt }],
        },
      }),
      turnTimeoutMs,
      `task ${task.id} (${arm}, rep ${rep})`,
    )
    if (promptResult.data === undefined) {
      return { answer: '', error: extractErrorMessage(promptResult.error) }
    }
    const infoError = promptResult.data.info.error
    return {
      answer: textFromParts(promptResult.data.parts),
      error: infoError === undefined || infoError === null ? null : extractErrorMessage(infoError),
    }
  } catch (error) {
    return { answer: '', error: extractErrorMessage(error) }
  }
}

const fetchMessages = async (client: OpencodeClient, sessionId: string): Promise<readonly SdkMessage[]> => {
  try {
    const listed = await client.session.messages({ path: { id: sessionId } })
    return (listed.data ?? []) as readonly SdkMessage[]
  } catch {
    // transcript unavailable — metrics degrade to empty, the turn error is already captured
    return []
  }
}

export const runRep = async (options: RunRepOptions): Promise<RunRecord> => {
  const { client, directory, task, arm, rep, agentModel, turnTimeoutMs } = options
  const created = await withTimeout(client.session.create({ query: { directory } }), turnTimeoutMs, 'session.create')
  if (created.data === undefined) {
    throw new Error(`session creation failed: ${extractErrorMessage(created.error)}`)
  }
  const sessionId: string = created.data.id

  const startedAtMs = Date.now()
  const turn = await sendTurn(client, sessionId, task, arm, rep, agentModel, turnTimeoutMs)
  const endedAtMs = Date.now()
  const messages = await fetchMessages(client, sessionId)

  return reduceMessagesToRunRecord({
    taskId: task.id,
    arm,
    rep,
    sessionId,
    agentModel: `${agentModel.providerID}/${agentModel.modelID}`,
    prompt: task.prompt,
    answer: turn.answer,
    wallTimeMs: endedAtMs - startedAtMs,
    compacted: hasCompaction(messages),
    finishedAt: new Date(endedAtMs).toISOString(),
    messages,
    error: turn.error,
  })
}

export const createBenchClient = (serverUrl: string, directory: string): OpencodeClient =>
  createOpencodeClient({ baseUrl: serverUrl, directory })
