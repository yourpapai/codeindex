import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { buildArmConfig, loadArmServerSpec, serializeArmConfig } from '../../bench/agents/config'

const server = { name: 'codeindex', command: ['bun', 'run', '/x/src/cli.ts', 'mcp'] }

describe('buildArmConfig', () => {
  test('with-arm enables the MCP server', () => {
    const config = buildArmConfig('with', server)
    expect(config.mcp?.['codeindex']?.enabled).toBe(true)
  })

  test('without-arm explicitly disables the MCP server to override project config', () => {
    const config = buildArmConfig('without', server)
    expect(config.mcp?.['codeindex']?.enabled).toBe(false)
  })

  test('both arms carry the same command array', () => {
    const withConfig = buildArmConfig('with', server)
    const withoutConfig = buildArmConfig('without', server)
    expect(JSON.stringify(withConfig.mcp?.['codeindex'])).toContain(JSON.stringify(server.command))
    expect(JSON.stringify(withoutConfig.mcp?.['codeindex'])).toContain(JSON.stringify(server.command))
  })

  test('serializes to JSON for OPENCODE_CONFIG_CONTENT', () => {
    const serialized = serializeArmConfig(buildArmConfig('with', server))
    expect(JSON.parse(serialized)).toEqual(buildArmConfig('with', server))
  })
})

describe('loadArmServerSpec', () => {
  test('reads the codeindex MCP block from a repo opencode.json', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agent-bench-config-'))
    try {
      writeFileSync(
        path.join(dir, 'opencode.json'),
        JSON.stringify({
          mcp: {
            codeindex: { type: 'local', command: ['bun', 'run', 'x.ts', 'mcp'], enabled: true },
            other: { type: 'local', command: ['echo'] },
          },
        }),
      )
      const spec = loadArmServerSpec(dir)
      expect(spec?.name).toBe('codeindex')
      expect(spec?.command).toEqual(['bun', 'run', 'x.ts', 'mcp'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('returns null when no codeindex server is registered', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agent-bench-config-'))
    try {
      writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify({ mcp: {} }))
      expect(loadArmServerSpec(dir)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('returns null when opencode.json is absent', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'agent-bench-config-'))
    try {
      expect(loadArmServerSpec(dir)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
