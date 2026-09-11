import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export interface TempRepo {
  readonly dir: string
  cleanup(): void
}

export const makeTempRepo = (options: {
  readonly prefix: string
  readonly symbolName?: string
  readonly extraFiles?: Readonly<Record<string, string>>
}): TempRepo => {
  const dir = mkdtempSync(path.join(tmpdir(), options.prefix))
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
  if (options.symbolName !== undefined) {
    writeFileSync(path.join(dir, 'src', 'thing.ts'), `export const ${options.symbolName} = (): number => 1\n`)
  }
  for (const [rel, contents] of Object.entries(options.extraFiles ?? {})) {
    const abs = path.join(dir, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, contents)
  }
  return {
    dir,
    cleanup(): void {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

export const cliPath = path.resolve(import.meta.dir, '../../src/cli.ts')
