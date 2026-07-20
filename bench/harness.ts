import type { Database } from 'bun:sqlite'

import { findIncomingReferences, searchSymbols } from '../src/search/index.js'
import { mean, precisionAtK, recallAtK, reciprocalRank } from './metrics.js'
import type { Corpus, CorpusReport, GoldenQuery, QueryScore } from './types.js'

const retrievedFor = (db: Database, query: GoldenQuery, k: number): readonly string[] => {
  if (query.kind === 'who-uses') {
    return findIncomingReferences(db, { qualifiedName: query.target, limit: k })
      .map((row) => row.sourceQualifiedName)
      .filter((name): name is string => name !== null)
  }
  return searchSymbols(db, { query: query.query, limit: k }).map((row) => row.qualifiedName)
}

const scoreQuery = (db: Database, query: GoldenQuery, k: number): QueryScore => {
  const retrieved = retrievedFor(db, query, k)
  const relevant = new Set(query.relevant)
  return {
    id: query.id,
    kind: query.kind,
    precisionAtK: precisionAtK(retrieved, relevant, k),
    recallAtK: recallAtK(retrieved, relevant, k),
    reciprocalRank: reciprocalRank(retrieved, relevant),
    retrieved,
    relevant: query.relevant,
  }
}

export const scoreCorpus = (db: Database, corpus: Corpus, k: number): CorpusReport => {
  const perQuery = corpus.queries.map((query) => scoreQuery(db, query, k))
  return {
    k,
    queryCount: perQuery.length,
    meanPrecisionAtK: mean(perQuery.map((score) => score.precisionAtK)),
    meanRecallAtK: mean(perQuery.map((score) => score.recallAtK)),
    mrr: mean(perQuery.map((score) => score.reciprocalRank)),
    perQuery,
  }
}
