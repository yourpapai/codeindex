import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const CHECKER_APIS = ['createLanguageService', 'createProgram', 'getReferencesAtPosition', 'findReferences']

const walk = (dir: string): readonly string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })

describe('bench-only type-checker boundary', () => {
  test('src/ constructs no TS type-checker (LanguageService/Program/findReferences)', () => {
    const offenders = walk(path.join(import.meta.dir, '../../src'))
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => CHECKER_APIS.some((api) => readFileSync(f, 'utf8').includes(api)))
    expect(offenders).toEqual([])
  })
})
