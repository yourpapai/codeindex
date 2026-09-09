import { describe, expect, test } from 'bun:test'
import path from 'node:path'

import { loadCorpus } from '../../bench/agents/corpus'

const corpusPath = path.join(import.meta.dir, '../../bench/agents/corpus.json')

describe('agent task corpus', () => {
  test('loads and validates against TaskSpec schema', async () => {
    const corpus = await loadCorpus(corpusPath)
    expect(corpus.name.length).toBeGreaterThan(0)
    expect(corpus.tasks.length).toBeGreaterThanOrEqual(10)
  })

  test('covers all five task kinds', async () => {
    const corpus = await loadCorpus(corpusPath)
    const kinds = new Set<string>(corpus.tasks.map((task) => task.kind))
    for (const kind of ['locate', 'who-uses', 'explain', 'review', 'map']) {
      expect(kinds.has(kind)).toBe(true)
    }
  })

  test('task ids are unique', async () => {
    const corpus = await loadCorpus(corpusPath)
    const ids = corpus.tasks.map((task) => task.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('ground-truth tasks carry non-empty expected symbols', async () => {
    const corpus = await loadCorpus(corpusPath)
    for (const task of corpus.tasks) {
      if (task.kind === 'locate' || task.kind === 'who-uses') {
        expect(task.groundTruth).toBeDefined()
        expect(task.groundTruth?.expected.length ?? 0).toBeGreaterThan(0)
      }
    }
  })

  test('subjective tasks carry judge notes', async () => {
    const corpus = await loadCorpus(corpusPath)
    for (const task of corpus.tasks) {
      if (task.kind === 'explain' || task.kind === 'review' || task.kind === 'map') {
        expect(task.judgeNotes?.length ?? 0).toBeGreaterThan(0)
      }
    }
  })
})
