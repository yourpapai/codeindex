import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import type { FuzzOperation, FuzzOperationKind, RepoFile, RepoModel } from './edit-fuzz-types.js'
import { pick, randomInt } from './fuzz-rng.js'
import type { Rng } from './fuzz-rng.js'

const OP_KINDS: readonly FuzzOperationKind[] = ['rename-symbol', 'rename-file', 'delete-file', 'edit-content']

const filePath = (model: RepoModel, name: string): string => path.join(model.dir, 'src', `${name}.ts`)

const applyRenameSymbol = (model: RepoModel, target: RepoFile): RepoModel => {
  const oldPath = filePath(model, target.name)
  const source = readFileSync(oldPath, 'utf8')
  const newSymbol = `${target.symbol}_r`
  const declarationPattern = new RegExp(`\\bconst ${target.symbol}\\b`, 'g')
  const updated = source.replace(declarationPattern, `const ${newSymbol}`)
  writeFileSync(oldPath, updated)
  const newFiles = model.files.map((file) => (file.name === target.name ? { ...file, symbol: newSymbol } : file))
  return { dir: model.dir, files: newFiles }
}

const applyRenameFile = (model: RepoModel, target: RepoFile): RepoModel => {
  const newName = `${target.name}_moved`
  const oldPath = filePath(model, target.name)
  const newPath = filePath(model, newName)
  renameSync(oldPath, newPath)
  const newFiles = model.files.map((file) => (file.name === target.name ? { ...file, name: newName } : file))
  return { dir: model.dir, files: newFiles }
}

const applyDeleteFile = (model: RepoModel, target: RepoFile): RepoModel => {
  rmSync(filePath(model, target.name))
  const newFiles = model.files.filter((file) => file.name !== target.name)
  return { dir: model.dir, files: newFiles }
}

const applyEditContent = (rng: Rng, model: RepoModel, target: RepoFile): RepoModel => {
  const targetPath = filePath(model, target.name)
  const source = readFileSync(targetPath, 'utf8')
  const unique = source.length + randomInt(rng, 1000)
  const returnValue = source.length % 1000
  const appended = `${source}export const extra${unique} = (): number => ${returnValue}\n`
  writeFileSync(targetPath, appended)
  return { dir: model.dir, files: model.files }
}

/**
 * Picks a target file and an operation kind from the rng (in that fixed order, so the
 * same seed always yields the same op + target), mutates `model.dir` on disk, and
 * returns the operation description plus the updated (never-mutated-in-place) model.
 */
export const applyRandomEdit = (rng: Rng, model: RepoModel): { operation: FuzzOperation; model: RepoModel } => {
  const targetIndex = randomInt(rng, model.files.length)
  const target = model.files[targetIndex]
  if (target === undefined) {
    throw new Error('applyRandomEdit called on a model with no files')
  }
  const canDelete = model.files.length > 1
  const kindPool = canDelete ? OP_KINDS : OP_KINDS.filter((kind) => kind !== 'delete-file')
  const kind = pick(rng, kindPool)
  const operation: FuzzOperation = { kind, target: target.name }

  if (kind === 'rename-symbol') {
    return { operation, model: applyRenameSymbol(model, target) }
  }
  if (kind === 'rename-file') {
    return { operation, model: applyRenameFile(model, target) }
  }
  if (kind === 'delete-file') {
    return { operation, model: applyDeleteFile(model, target) }
  }
  return { operation, model: applyEditContent(rng, model, target) }
}
