import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { RepoFile, RepoModel } from './edit-fuzz-types.js'

const moduleSource = (index: number): string => {
  if (index === 0) {
    return `export const sym0 = (): number => 0\n`
  }
  const previous = index - 1
  return (
    `import { sym${previous} } from './mod${previous}.js'\n` +
    `export const sym${index} = (): number => sym${previous}() + ${index}\n`
  )
}

export const generateChainRepo = (dir: string, fileCount: number): RepoModel => {
  mkdirSync(path.join(dir, 'src'), { recursive: true })
  writeFileSync(path.join(dir, '.codeindex.json'), JSON.stringify({ roots: ['src'] }))
  const files: RepoFile[] = []
  for (let index = 0; index < fileCount; index += 1) {
    writeFileSync(path.join(dir, 'src', `mod${index}.ts`), moduleSource(index))
    files.push({ name: `mod${index}`, symbol: `sym${index}` })
  }
  return { dir, files }
}
