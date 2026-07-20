import { readFile } from 'node:fs/promises'

import { z } from 'zod'

import type { Corpus } from './types.js'

const FindSymbolQuerySchema = z.object({
  id: z.string().min(1),
  kind: z.literal('find-symbol'),
  query: z.string().min(1),
  relevant: z.array(z.string().min(1)),
})

const NlIntentQuerySchema = z.object({
  id: z.string().min(1),
  kind: z.literal('nl-intent'),
  query: z.string().min(1),
  relevant: z.array(z.string().min(1)),
})

const WhoUsesQuerySchema = z.object({
  id: z.string().min(1),
  kind: z.literal('who-uses'),
  target: z.string().min(1),
  relevant: z.array(z.string().min(1)),
})

const CorpusSchema = z.object({
  name: z.string().min(1),
  queries: z.array(z.discriminatedUnion('kind', [FindSymbolQuerySchema, NlIntentQuerySchema, WhoUsesQuerySchema])),
})

export const parseCorpus = (raw: unknown): Corpus => CorpusSchema.parse(raw)

export const loadCorpus = async (filePath: string): Promise<Corpus> => {
  const contents = await readFile(filePath, 'utf8')
  return parseCorpus(JSON.parse(contents) as unknown)
}
