import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { readGitInfo } from '../../src/indexer/git-info.js'

describe('readGitInfo', () => {
  test('reads commit and branch from a real git repo', () => {
    const info = readGitInfo(process.cwd())
    const expectedCommit = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: process.cwd() }).stdout.toString().trim()
    expect(info.commit).toBe(expectedCommit)
    expect(info.commit).not.toBeNull()
    expect(info.branch).not.toBeNull()
  })

  test('returns null fields for a non-git directory', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-nogit-'))
    try {
      const info = readGitInfo(dir)
      expect(info.commit).toBeNull()
      expect(info.branch).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
