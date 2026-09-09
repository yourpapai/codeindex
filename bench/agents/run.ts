import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { z } from 'zod'

import { readRepoHead, warnOnCorpusDrift } from '../git-stamp'
import { formatModelRef, parseArgs, type ModelRef } from './args'
import { loadArmServerSpec } from './config'
import { loadCorpus } from './corpus'
import { gradeRecords, gradeDbPath, judgeSubjectiveTasks, makeJudgeOnce } from './pipeline'
import { buildReport, formatReportText, judgeTally, type BuildReportInput } from './report'
import { startOpencodeServe } from './serve'
import { runRep, createBenchClient } from './session-run'
import type { JudgeVerdict, ObjectiveGrade, RunRecord, TaskSpec } from './types'

const BaselineRepoHeadSchema = z.object({
  repoHead: z.string().nullable().optional(),
})

export interface ScheduleItem {
  readonly task: TaskSpec
  readonly arm: 'with' | 'without'
  readonly rep: number
}

export const buildSchedule = (
  tasks: readonly TaskSpec[],
  reps: number,
  filterTaskIds?: ReadonlySet<string>,
): readonly ScheduleItem[] => {
  const schedule: ScheduleItem[] = []
  for (const task of tasks) {
    if (filterTaskIds !== undefined && !filterTaskIds.has(task.id)) {
      continue
    }
    for (let rep = 0; rep < reps; rep += 1) {
      schedule.push({ task, arm: 'with', rep })
      schedule.push({ task, arm: 'without', rep })
    }
  }
  return schedule
}

const prewarmIndex = async (repo: string): Promise<void> => {
  const { loadCodeindexConfig } = await import('../../src/config.js')
  const { indexCodebase } = await import('../../src/indexer/index-codebase.js')
  const config = await loadCodeindexConfig({
    configPath: path.join(repo, '.codeindex.json'),
    repoRoot: repo,
  })
  await indexCodebase({ config, mode: 'full' })
}

const persistRecord = (record: RunRecord, runsDir: string): string => {
  const filePath = path.join(runsDir, `${record.taskId}.${record.arm}.r${record.rep}.json`)
  writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`)
  return filePath
}

interface ArmServers {
  readonly withUrl: string
  readonly withoutUrl: string
  close(): Promise<void>
}

const startArmServers = async (
  repo: string,
  serverCommand: readonly string[],
  serverName: string,
  startupTimeoutMs: number,
): Promise<ArmServers> => {
  const withServer = await startOpencodeServe({
    cwd: repo,
    config: { mcp: { [serverName]: { type: 'local', command: [...serverCommand], enabled: true } } },
    startupTimeoutMs,
  })
  try {
    const withoutServer = await startOpencodeServe({
      cwd: repo,
      config: { mcp: { [serverName]: { type: 'local', command: [...serverCommand], enabled: false } } },
      startupTimeoutMs,
    })
    return {
      withUrl: withServer.url,
      withoutUrl: withoutServer.url,
      close: async () => {
        await withServer.close()
        await withoutServer.close()
      },
    }
  } catch (error) {
    await withServer.close()
    throw error
  }
}

const runAllReps = async (
  remaining: readonly ScheduleItem[],
  context: {
    readonly clients: {
      readonly with: ReturnType<typeof createBenchClient>
      readonly without: ReturnType<typeof createBenchClient>
    }
    readonly directory: string
    readonly agentModel: ModelRef
    readonly turnTimeoutMs: number
    readonly runsDir: string
    readonly total: number
    readonly collected: RunRecord[]
  },
): Promise<readonly RunRecord[]> => {
  const [head, ...tail] = remaining
  if (head === undefined) {
    return context.collected
  }
  const label = `[${context.total - remaining.length + 1}/${context.total}] ${head.task.id} arm=${head.arm} rep=${head.rep}`
  process.stdout.write(`${label}\n`)
  const record = await runRep({
    client: context.clients[head.arm],
    directory: context.directory,
    task: head.task,
    arm: head.arm,
    rep: head.rep,
    agentModel: context.agentModel,
    turnTimeoutMs: context.turnTimeoutMs,
  })
  persistRecord(record, context.runsDir)
  context.collected.push(record)
  return runAllReps(tail, context)
}

const writeBaselineFile = (
  baselinePath: string,
  report: ReturnType<typeof buildReport>,
  comparisons: readonly JudgeVerdict[],
  meta: { readonly repo: string; readonly repoHead: string | null; readonly agentModel: string; readonly reps: number },
): void => {
  const baselineFile = {
    generatedAt: report.generatedAt,
    repo: meta.repo,
    repoHead: meta.repoHead,
    agentModel: meta.agentModel,
    reps: meta.reps,
    arms: report.arms,
    judge: judgeTally(comparisons),
  }
  writeFileSync(baselinePath, `${JSON.stringify(baselineFile, null, 2)}\n`)
  process.stdout.write(`baseline written to ${baselinePath}\n`)
}

const finishRun = (options: {
  readonly args: ReturnType<typeof parseArgs>
  readonly runsDir: string
  readonly records: readonly RunRecord[]
  readonly grades: readonly ObjectiveGrade[]
  readonly comparisons: readonly JudgeVerdict[]
}): void => {
  const { args, runsDir, records, grades, comparisons } = options
  const generatedAt = new Date().toISOString()
  let baselineInput: BuildReportInput['baseline'] = null
  if (args.baseline !== null) {
    const raw: unknown = JSON.parse(readFileSync(args.baseline, 'utf8'))
    baselineInput = { path: args.baseline, data: raw }
    const stamped = BaselineRepoHeadSchema.nullish().parse(raw)
    warnOnCorpusDrift(stamped?.repoHead ?? null, readRepoHead(args.repo), 'agent-bench')
  }
  if (args.agentModel === null) {
    throw new Error('agent model disappeared before report')
  }
  const report = buildReport({
    generatedAt,
    repo: args.repo,
    agentModel: formatModelRef(args.agentModel),
    judgeModel: args.judgeModel === null ? null : formatModelRef(args.judgeModel),
    reps: args.reps,
    records,
    grades,
    comparisons,
    baseline: baselineInput,
  })
  writeFileSync(path.join(runsDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`\n${formatReportText(report)}\n`)
  process.stdout.write(`report written to ${path.join(runsDir, 'report.json')}\n`)

  if (args.writeBaseline) {
    writeBaselineFile(path.join(args.repo, 'bench/agents/baseline.json'), report, comparisons, {
      repo: args.repo,
      repoHead: readRepoHead(args.repo),
      agentModel: formatModelRef(args.agentModel),
      reps: args.reps,
    })
  }
}

interface RunPlan {
  readonly serverCommand: readonly string[]
  readonly serverName: string
  readonly corpus: Awaited<ReturnType<typeof loadCorpus>>
  readonly schedule: readonly ScheduleItem[]
}

const resolveRunPlan = async (args: ReturnType<typeof parseArgs>): Promise<RunPlan> => {
  const serverSpec = loadArmServerSpec(args.repo)
  if (serverSpec === null) {
    throw new Error(`no codeindex MCP server registered in ${path.join(args.repo, 'opencode.json')}`)
  }
  const corpus = await loadCorpus(args.corpus)
  const schedule = buildSchedule(corpus.tasks, args.reps, args.taskFilter ?? undefined)
  if (schedule.length === 0) {
    throw new Error(
      `no tasks to run for filter '${[...(args.taskFilter ?? [])].join(',') || '(none)'}' — known task ids: ${corpus.tasks.map((task) => task.id).join(', ')}`,
    )
  }
  return { serverCommand: serverSpec.command, serverName: serverSpec.name, corpus, schedule }
}

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2))
  if (args.agentModel === null) {
    throw new Error('agent model is required: pass --agent-model providerID/modelID or set AGENT_BENCH_MODEL')
  }
  const plan = await resolveRunPlan(args)

  process.stdout.write(`pre-warming index for ${args.repo}\n`)
  await prewarmIndex(args.repo)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const runsDir = path.join(args.repo, 'bench/agents/runs', stamp)
  mkdirSync(runsDir, { recursive: true })

  process.stdout.write('starting arm servers\n')
  const servers = await startArmServers(args.repo, plan.serverCommand, plan.serverName, args.startupTimeoutMs)
  try {
    const clients = {
      with: createBenchClient(servers.withUrl, args.repo),
      without: createBenchClient(servers.withoutUrl, args.repo),
    }
    const records = await runAllReps(plan.schedule, {
      clients,
      directory: args.repo,
      agentModel: args.agentModel,
      turnTimeoutMs: args.turnTimeoutMs,
      runsDir,
      total: plan.schedule.length,
      collected: [],
    })

    const grades = gradeRecords(records, plan.corpus.tasks, gradeDbPath(args.repo))
    let comparisons: readonly JudgeVerdict[] = []
    if (args.judgeModel !== null) {
      comparisons = await judgeSubjectiveTasks({
        tasks: plan.corpus.tasks,
        records,
        judgeOnce: makeJudgeOnce(clients.with, args.repo, args.judgeModel, args.turnTimeoutMs),
      })
    }
    finishRun({ args, runsDir, records, grades, comparisons })
  } finally {
    await servers.close()
  }
}

process.on('unhandledRejection', (error) => {
  process.stderr.write(`unhandled rejection: ${String(error)}\n`)
  process.exit(1)
})

if (import.meta.main) {
  await main()
}
