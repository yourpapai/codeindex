import { describe, expect, test } from 'bun:test'

import { reduceMessagesToRunRecord, type SdkMessage } from '../../bench/agents/reducer'

const assistantInfo = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'msg_1',
  sessionID: 'ses_1',
  role: 'assistant',
  parentID: 'usr_1',
  modelID: 'glm-5.3-flash',
  providerID: 'opencode-go',
  mode: 'build',
  path: { cwd: '/repo', root: '/repo' },
  cost: 0.01,
  tokens: { input: 100, output: 50, reasoning: 10, cache: { read: 200, write: 20 } },
  time: { created: 1_000 },
  ...overrides,
})

const toolPart = (callID: string, tool: string, status: string): Record<string, unknown> => ({
  id: `part_${callID}`,
  sessionID: 'ses_1',
  messageID: 'msg_1',
  type: 'tool',
  callID,
  tool,
  state: { status, input: {}, output: 'out', title: tool, metadata: {}, time: { start: 1, end: 2 } },
})

const textPart = (text: string): Record<string, unknown> => ({
  id: `part_text_${text.length}`,
  sessionID: 'ses_1',
  messageID: 'msg_1',
  type: 'text',
  text,
})

const baseInput = {
  taskId: 'locate-openDatabase',
  arm: 'with' as const,
  rep: 0,
  sessionId: 'ses_1',
  agentModel: 'opencode-go/glm-5.3-flash',
  prompt: 'Where is openDatabase implemented?',
  wallTimeMs: 4200,
  compacted: false,
  finishedAt: '2026-09-09T12:00:00.000Z',
}

describe('reduceMessagesToRunRecord', () => {
  test('folds tool calls in order, deduping streaming updates by callID', () => {
    const messages: readonly SdkMessage[] = [
      {
        info: { id: 'usr', sessionID: 'ses_1', role: 'user', time: { created: 900 } } as SdkMessage['info'],
        parts: [textPart('Where is openDatabase implemented?')],
      },
      {
        info: assistantInfo() as SdkMessage['info'],
        parts: [
          { ...toolPart('c1', 'grep', 'pending'), state: { status: 'pending', input: {} } },
          {
            ...toolPart('c1', 'grep', 'completed'),
            state: { status: 'completed', input: {}, output: '', title: '', metadata: {}, time: {} },
          },
          toolPart('c2', 'codeindex_code_search', 'completed'),
        ],
      },
    ]
    const record = reduceMessagesToRunRecord({ ...baseInput, messages, answer: 'x' })
    expect(record.toolCalls).toEqual([
      { tool: 'grep', status: 'completed' },
      { tool: 'codeindex_code_search', status: 'completed' },
    ])
  })

  test('preserves errored tool status', () => {
    const messages: readonly SdkMessage[] = [
      {
        info: assistantInfo() as SdkMessage['info'],
        parts: [toolPart('c1', 'codeindex_code_symbol', 'error')],
      },
    ]
    const record = reduceMessagesToRunRecord({ ...baseInput, messages, answer: 'x' })
    expect(record.toolCalls).toEqual([{ tool: 'codeindex_code_symbol', status: 'error' }])
  })

  test('sums tokens and cost across assistant messages', () => {
    const messages: readonly SdkMessage[] = [
      {
        info: assistantInfo({ id: 'msg_1', cost: 0.01 }) as SdkMessage['info'],
        parts: [toolPart('c1', 'grep', 'completed')],
      },
      {
        info: assistantInfo({
          id: 'msg_2',
          cost: 0.02,
          tokens: { input: 300, output: 20, reasoning: 0, cache: { read: 400, write: 0 } },
        }) as SdkMessage['info'],
        parts: [textPart('It is in src/storage/db.ts.')],
      },
    ]
    const record = reduceMessagesToRunRecord({ ...baseInput, messages, answer: 'final' })
    expect(record.tokens).toEqual({ input: 400, output: 70, reasoning: 10, cacheRead: 600, cacheWrite: 20 })
    expect(record.cost).toBeCloseTo(0.03, 6)
  })

  test('carries prompt, wall time, model, session, compaction flag', () => {
    const messages: readonly SdkMessage[] = [
      { info: assistantInfo() as SdkMessage['info'], parts: [textPart('answer')] },
    ]
    const record = reduceMessagesToRunRecord({ ...baseInput, compacted: true, messages, answer: 'answer' })
    expect(record.prompt).toBe(baseInput.prompt)
    expect(record.wallTimeMs).toBe(4200)
    expect(record.agentModel).toBe('opencode-go/glm-5.3-flash')
    expect(record.sessionId).toBe('ses_1')
    expect(record.compacted).toBe(true)
    expect(record.finishedAt).toBe('2026-09-09T12:00:00.000Z')
  })

  test('zero-token run (model errored) still yields a valid record', () => {
    const messages: readonly SdkMessage[] = []
    const record = reduceMessagesToRunRecord({
      ...baseInput,
      messages,
      answer: '',
      error: 'ProviderAuthError',
    })
    expect(record.tokens.input).toBe(0)
    expect(record.toolCalls).toEqual([])
    expect(record.error).toBe('ProviderAuthError')
  })

  test('rejects malformed message payloads loudly', () => {
    const messages: readonly SdkMessage[] = [{ info: 42, parts: [42] }]
    expect(() => reduceMessagesToRunRecord({ ...baseInput, messages, answer: '' })).toThrow()
  })
})
