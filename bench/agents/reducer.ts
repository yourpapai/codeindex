import { z } from 'zod'

import { RunRecordSchema, type RunRecord, type ToolCall } from './types'

const TokenUsageSdkSchema = z.object({
  input: z.number(),
  output: z.number(),
  reasoning: z.number(),
  cache: z.object({ read: z.number(), write: z.number() }),
})

const AssistantInfoSchema = z.object({
  role: z.literal('assistant'),
  cost: z.number(),
  tokens: TokenUsageSdkSchema,
})

const ToolStateSdkSchema = z.object({ status: z.string() })

const ToolPartSdkSchema = z.object({
  type: z.literal('tool'),
  callID: z.string(),
  tool: z.string(),
  state: ToolStateSdkSchema,
})

const MessageInfoSchema = z.object({
  role: z.string(),
})

const SdkMessageSchema = z.object({
  info: MessageInfoSchema,
  parts: z.array(z.object({ type: z.string() }).loose()),
})

export interface SdkMessage {
  readonly info: unknown
  readonly parts: readonly unknown[]
}

export interface ReduceRunInput {
  readonly taskId: string
  readonly arm: 'with' | 'without'
  readonly rep: number
  readonly sessionId: string
  readonly agentModel: string
  readonly prompt: string
  readonly answer: string
  readonly wallTimeMs: number
  readonly compacted: boolean
  readonly finishedAt: string
  readonly messages: readonly SdkMessage[]
  readonly error?: string | null
}

const zeroTokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }

interface TokenTotals {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

const asTokens = (tokens: z.infer<typeof TokenUsageSdkSchema>): TokenTotals => ({
  input: tokens.input,
  output: tokens.output,
  reasoning: tokens.reasoning,
  cacheRead: tokens.cache.read,
  cacheWrite: tokens.cache.write,
})

const toolStatus = (status: string): ToolCall['status'] => {
  switch (status) {
    case 'pending':
    case 'running':
    case 'completed':
    case 'error':
      return status
    default:
      return 'error'
  }
}

const accumulateTokens = (totals: TokenTotals, messageTokens: TokenTotals): TokenTotals => ({
  input: totals.input + messageTokens.input,
  output: totals.output + messageTokens.output,
  reasoning: totals.reasoning + messageTokens.reasoning,
  cacheRead: totals.cacheRead + messageTokens.cacheRead,
  cacheWrite: totals.cacheWrite + messageTokens.cacheWrite,
})

const collectToolCalls = (
  parts: readonly unknown[],
  toolCallsByCallId: Map<string, ToolCall>,
  toolCallOrder: string[],
): void => {
  for (const part of parts) {
    const parsedPart = ToolPartSdkSchema.safeParse(part)
    if (!parsedPart.success) {
      continue
    }
    const { callID, tool, state } = parsedPart.data
    if (!toolCallsByCallId.has(callID)) {
      toolCallOrder.push(callID)
    }
    toolCallsByCallId.set(callID, { tool, status: toolStatus(state.status) })
  }
}

export const reduceMessagesToRunRecord = (input: ReduceRunInput): RunRecord => {
  const toolCallsByCallId = new Map<string, ToolCall>()
  const toolCallOrder: string[] = []
  let tokens: TokenTotals = { ...zeroTokens }
  let cost = 0

  for (const message of input.messages) {
    SdkMessageSchema.parse(message)
    const info = AssistantInfoSchema.safeParse(message.info)
    if (!info.success) {
      continue
    }
    const messageTokens = asTokens(TokenUsageSdkSchema.parse(info.data.tokens))
    tokens = accumulateTokens(tokens, messageTokens)
    cost += info.data.cost
    collectToolCalls(message.parts, toolCallsByCallId, toolCallOrder)
  }

  const toolCalls = toolCallOrder.flatMap((callID) => {
    const call = toolCallsByCallId.get(callID)
    return call === undefined ? [] : [call]
  })

  return RunRecordSchema.parse({
    taskId: input.taskId,
    arm: input.arm,
    rep: input.rep,
    sessionId: input.sessionId,
    agentModel: input.agentModel,
    prompt: input.prompt,
    answer: input.answer,
    tokens,
    cost,
    toolCalls,
    wallTimeMs: input.wallTimeMs,
    compacted: input.compacted,
    error: input.error ?? null,
    finishedAt: input.finishedAt,
  })
}
