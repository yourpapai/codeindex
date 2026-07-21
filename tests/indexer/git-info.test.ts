import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { readGitInfo } from '../../src/indexer/git-info.js'

const runGitSetupCommand = (cwd: string, args: readonly string[]): void => {
  const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
  }
}

const setUpDetachedHeadRepo = (dir: string): void => {
  runGitSetupCommand(dir, ['init'])
  runGitSetupCommand(dir, ['config', 'user.email', 't@t.com'])
  runGitSetupCommand(dir, ['config', 'user.name', 'Test'])
  writeFileSync(path.join(dir, 'file.txt'), 'hello')
  runGitSetupCommand(dir, ['add', 'file.txt'])
  runGitSetupCommand(dir, ['commit', '-m', 'initial commit'])

  const sha = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: dir }).stdout.toString().trim()
  runGitSetupCommand(dir, ['checkout', '--detach', sha])
}

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

  test('normalizes a detached HEAD to a null branch', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-detached-'))
    try {
      setUpDetachedHeadRepo(dir)

      const info = readGitInfo(dir)
      expect(info.commit).not.toBeNull()
      expect(info.branch).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
