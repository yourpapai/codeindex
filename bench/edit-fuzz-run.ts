import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { runEditFuzz } from './edit-fuzz.js'

interface FuzzArgs {
  readonly seed: number
  readonly files: number
  readonly sequences: number
  readonly edits: number
}

const parseArgs = (argv: readonly string[]): FuzzArgs => {
  let seed = 1
  let files = 8
  let sequences = 20
  let edits = 6
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--seed' && value !== undefined) {
      seed = Number.parseInt(value, 10)
      index += 1
    } else if (flag === '--files' && value !== undefined) {
      files = Number.parseInt(value, 10)
      index += 1
    } else if (flag === '--sequences' && value !== undefined) {
      sequences = Number.parseInt(value, 10)
      index += 1
    } else if (flag === '--edits' && value !== undefined) {
      edits = Number.parseInt(value, 10)
      index += 1
    }
  }
  return { seed, files, sequences, edits }
}

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2))
  const dir = mkdtempSync(path.join(tmpdir(), 'codeindex-fuzz-run-'))
  try {
    const report = await runEditFuzz({
      dir,
      seed: args.seed,
      fileCount: args.files,
      sequenceCount: args.sequences,
      editsPerSequence: args.edits,
    })
    console.log(JSON.stringify(report, null, 2))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
