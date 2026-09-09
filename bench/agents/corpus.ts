import { z } from 'zod'

import { TaskSpecSchema, type TaskSpec } from './types'

export interface AgentTaskCorpus {
  readonly name: string
  readonly tasks: readonly TaskSpec[]
}

const CorpusFileSchema = z.object({
  name: z.string().min(1),
  tasks: z.array(TaskSpecSchema),
})

export const parseCorpus = (raw: unknown): AgentTaskCorpus => CorpusFileSchema.parse(raw)

export const loadCorpus = async (corpusPath: string): Promise<AgentTaskCorpus> => {
  const raw: unknown = JSON.parse(await Bun.file(corpusPath).text())
  return parseCorpus(raw)
}
