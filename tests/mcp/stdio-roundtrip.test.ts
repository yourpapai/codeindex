import { afterEach, describe, expect, test } from 'bun:test'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

import { indexCodebase } from '../../src/indexer/index-codebase.js'
import { loadConfigForPath } from '../../src/cli.js'
import { CodeSearchOutputSchema } from '../../src/mcp/tools.js'
import { cliPath, makeTempRepo, type TempRepo } from './protocol-harness.js'

const repos: TempRepo[] = []
const transports: StdioClientTransport[] = []

afterEach(async () => {
  for (const transport of transports.splice(0)) {
    await transport.close().catch(() => undefined)
  }
  for (const repo of repos.splice(0)) {
    repo.cleanup()
  }
})

const connectStdio = async (cwd: string): Promise<Client> => {
  const transport = new StdioClientTransport({
    command: 'bun',
    args: [cliPath, 'mcp'],
    cwd,
    stderr: 'pipe',
  })
  transports.push(transport)
  const client = new Client({ name: 'stdio-roundtrip-test', version: '0.0.0' })
  await client.connect(transport)
  return client
}

describe('stdio protocol round-trip', () => {
  test('listTools includes the four tools and code_search returns a structured payload', async () => {
    const repo = makeTempRepo({ prefix: 'codeindex-stdio-roundtrip-', symbolName: 'stdioBeacon' })
    repos.push(repo)

    const config = await loadConfigForPath(repo.dir)
    await indexCodebase({ config, mode: 'full' })

    const client = await connectStdio(repo.dir)

    const tools = await client.listTools()
    const names = tools.tools.map((tool) => tool.name).sort()
    expect(names).toEqual(['code_impact', 'code_index', 'code_search', 'code_symbol'])

    const search = await client.callTool({ name: 'code_search', arguments: { query: 'stdioBeacon' } })
    expect(search.isError).not.toBe(true)
    const payload = CodeSearchOutputSchema.parse(search.structuredContent)
    expect(payload.resultCount).toBeGreaterThanOrEqual(1)
    expect(payload.results.some((row) => row.qualifiedName === 'src/thing#stdioBeacon')).toBe(true)
  })
})
