import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { readRepoHead, warnOnCorpusDrift } from '../../bench/git-stamp.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs) {
    Bun.spawnSync(['rm', '-rf', dir])
  }
  dirs.length = 0
})

const writeStampFile = (dir: string): void => {
  writeFileSync(path.join(dir, 'file.txt'), 'x\n')
}

describe('readRepoHead', () => {
  test('returns the commit sha in a git repo', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-stamp-'))
    dirs.push(dir)
    Bun.spawnSync(['git', 'init'], { cwd: dir })
    Bun.spawnSync(['git', 'config', 'user.email', 't@t'], { cwd: dir })
    Bun.spawnSync(['git', 'config', 'user.name', 't'], { cwd: dir })
    writeStampFile(dir)
    Bun.spawnSync(['git', 'add', '-A'], { cwd: dir })
    Bun.spawnSync(['git', 'commit', '-m', 'init'], { cwd: dir })
    const head = readRepoHead(dir)
    expect(head).toMatch(/^[0-9a-f]{40}$/)
  })

  test('returns null outside a git repo', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-stamp-nogit-'))
    dirs.push(dir)
    expect(readRepoHead(dir)).toBeNull()
  })
})

describe('warnOnCorpusDrift', () => {
  test('warns when the baseline stamp differs from the current head', () => {
    const errSpy = spyOn(console, 'error')
    try {
      warnOnCorpusDrift('aaaa', 'bbbb', 'IR')
      expect(errSpy).toHaveBeenCalled()
      const output = errSpy.mock.calls.map((call) => call.join(' ')).join('\n')
      expect(output).toContain('corpus drift')
      expect(output).toContain('IR')
    } finally {
      errSpy.mockRestore()
    }
  })

  test('warns when the baseline has no stamp (legacy file)', () => {
    const errSpy = spyOn(console, 'error')
    try {
      warnOnCorpusDrift(undefined, 'bbbb', 'impact')
      const output = errSpy.mock.calls.map((call) => call.join(' ')).join('\n')
      expect(output).toContain('corpus drift')
    } finally {
      errSpy.mockRestore()
    }
  })

  test('stays silent when the stamps match', () => {
    const errSpy = spyOn(console, 'error')
    try {
      warnOnCorpusDrift('aaaa', 'aaaa', 'IR')
      expect(errSpy).not.toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
    }
  })
})
