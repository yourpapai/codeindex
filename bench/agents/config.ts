import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

export interface ArmServerSpec {
  readonly name: string
  readonly command: readonly string[]
}

export type Arm = 'with' | 'without'

export interface ArmConfig {
  readonly mcp?: Record<
    string,
    { readonly type: 'local'; readonly command: readonly string[]; readonly enabled: boolean }
  >
}

const OpencodeProjectConfigSchema = z.object({
  mcp: z
    .record(
      z.string(),
      z.looseObject({
        command: z.array(z.string()),
      }),
    )
    .optional(),
})

export const buildArmConfig = (arm: Arm, server: ArmServerSpec): ArmConfig => ({
  mcp: {
    [server.name]: {
      type: 'local',
      command: [...server.command],
      enabled: arm === 'with',
    },
  },
})

export const serializeArmConfig = (config: ArmConfig): string => JSON.stringify(config)

export const loadArmServerSpec = (repoDir: string): ArmServerSpec | null => {
  const configPath = path.join(repoDir, 'opencode.json')
  if (!existsSync(configPath)) {
    return null
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'))
  } catch {
    return null
  }
  const parsed = OpencodeProjectConfigSchema.safeParse(raw)
  if (!parsed.success || parsed.data.mcp === undefined) {
    return null
  }
  const block = parsed.data.mcp['codeindex']
  if (block === undefined) {
    return null
  }
  return { name: 'codeindex', command: block.command }
}
