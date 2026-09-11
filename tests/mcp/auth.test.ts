import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

import { loadConfigForPath } from '../../src/cli.js'
import { indexCodebase } from '../../src/indexer/index-codebase.js'
import { CodeSearchOutputSchema } from '../../src/mcp/tools.js'
import { loadServeToken, validateServeToken } from '../../src/mcp/serve.js'
import { makeTempRepo, type TempRepo } from './protocol-harness.js'

const LONG_TOKEN = 'test-token-0123456789abcdef0123456789'
const SHORT_TOKEN = 'too-short'

const repos: TempRepo[] = []
const clients: Client[] = []
const stops: Array<() => Promise<void>> = []
const savedEnv: Record<'CODEINDEX_TOKEN' | 'CODEINDEX_TOKEN_FILE', string | undefined> = {
  CODEINDEX_TOKEN: process.env['CODEINDEX_TOKEN'],
  CODEINDEX_TOKEN_FILE: process.env['CODEINDEX_TOKEN_FILE'],
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    await client.close().catch(() => undefined)
  }
  for (const stop of stops.splice(0)) {
    await stop().catch(() => undefined)
  }
  for (const repo of repos.splice(0)) {
    repo.cleanup()
  }
  if (savedEnv.CODEINDEX_TOKEN === undefined) delete process.env['CODEINDEX_TOKEN']
  else process.env['CODEINDEX_TOKEN'] = savedEnv.CODEINDEX_TOKEN
  if (savedEnv.CODEINDEX_TOKEN_FILE === undefined) delete process.env['CODEINDEX_TOKEN_FILE']
  else process.env['CODEINDEX_TOKEN_FILE'] = savedEnv.CODEINDEX_TOKEN_FILE
})

const connectHttp = async (
  url: string,
  options: { readonly token?: string } = {},
): Promise<Client> => {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit:
      options.token === undefined
        ? undefined
        : { headers: { Authorization: `Bearer ${options.token}` } },
  })
  const client = new Client({ name: 'auth-test', version: '0.0.0' })
  clients.push(client)
  await client.connect(transport)
  return client
}

describe('serve token helpers', () => {
  test('rejects tokens shorter than 32 characters', () => {
    expect(() => validateServeToken(SHORT_TOKEN)).toThrow(/32/)
    expect(validateServeToken(LONG_TOKEN)).toBe(LONG_TOKEN)
  })

  test('loadServeToken reads CODEINDEX_TOKEN', () => {
    process.env['CODEINDEX_TOKEN'] = LONG_TOKEN
    delete process.env['CODEINDEX_TOKEN_FILE']
    expect(loadServeToken()).toBe(LONG_TOKEN)
  })

  test('loadServeToken reads CODEINDEX_TOKEN_FILE', () => {
    delete process.env['CODEINDEX_TOKEN']
    const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-token-'))
    const file = path.join(dir, 'token')
    writeFileSync(file, `${LONG_TOKEN}\n`)
    process.env['CODEINDEX_TOKEN_FILE'] = file
    expect(loadServeToken()).toBe(LONG_TOKEN)
  })

  test('loadServeToken returns null when unset', () => {
    delete process.env['CODEINDEX_TOKEN']
    delete process.env['CODEINDEX_TOKEN_FILE']
    expect(loadServeToken()).toBeNull()
  })
})

describe('serve bearer auth', () => {
  test('no token configured: tool call succeeds without Authorization', async () => {
    const { startServe } = await import('../../src/mcp/serve.js')
    const repo = makeTempRepo({ prefix: 'codeindex-auth-off-', symbolName: 'authOffBeacon' })
    repos.push(repo)
    const config = await loadConfigForPath(repo.dir)
    await indexCodebase({ config, mode: 'full' })
    const handle = await startServe(config, { port: 0 })
    stops.push(handle.stop)

    const client = await connectHttp(handle.url)
    const search = await client.callTool({ name: 'code_search', arguments: { query: 'authOffBeacon' } })
    expect(search.isError).not.toBe(true)
    const payload = CodeSearchOutputSchema.parse(search.structuredContent)
    expect(payload.resultCount).toBeGreaterThanOrEqual(1)
  })

  test('configured token: missing or wrong bearer returns 401 with WWW-Authenticate', async () => {
    const { startServe } = await import('../../src/mcp/serve.js')
    const repo = makeTempRepo({ prefix: 'codeindex-auth-401-' })
    repos.push(repo)
    const config = await loadConfigForPath(repo.dir)
    const handle = await startServe(config, { port: 0, token: LONG_TOKEN })
    stops.push(handle.stop)

    const missing = await fetch(handle.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(missing.status).toBe(401)
    expect(missing.headers.get('www-authenticate')).toBe('Bearer')

    const wrong = await fetch(handle.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: 'Bearer wrong-token-wrong-token-wrong-token!',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    })
    expect(wrong.status).toBe(401)
    expect(wrong.headers.get('www-authenticate')).toBe('Bearer')
  })

  test('configured token: matching bearer completes a tool call', async () => {
    const { startServe } = await import('../../src/mcp/serve.js')
    const repo = makeTempRepo({ prefix: 'codeindex-auth-ok-', symbolName: 'authOkBeacon' })
    repos.push(repo)
    const config = await loadConfigForPath(repo.dir)
    await indexCodebase({ config, mode: 'full' })
    const handle = await startServe(config, { port: 0, token: LONG_TOKEN })
    stops.push(handle.stop)

    const client = await connectHttp(handle.url, { token: LONG_TOKEN })
    const search = await client.callTool({ name: 'code_search', arguments: { query: 'authOkBeacon' } })
    expect(search.isError).not.toBe(true)
    const payload = CodeSearchOutputSchema.parse(search.structuredContent)
    expect(payload.resultCount).toBeGreaterThanOrEqual(1)
  })
})
