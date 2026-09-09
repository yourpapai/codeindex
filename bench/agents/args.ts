import path from 'node:path'

export interface ModelRef {
  readonly providerID: string
  readonly modelID: string
}

export const parseModelRef = (raw: string): ModelRef => {
  const separatorIndex = raw.indexOf('/')
  if (separatorIndex <= 0 || separatorIndex === raw.length - 1) {
    throw new Error(`invalid model reference "${raw}" — expected "providerID/modelID"`)
  }
  return { providerID: raw.slice(0, separatorIndex), modelID: raw.slice(separatorIndex + 1) }
}

export const formatModelRef = (model: ModelRef): string => `${model.providerID}/${model.modelID}`

export interface BenchArgs {
  readonly repo: string
  readonly corpus: string
  readonly reps: number
  readonly agentModel: ModelRef | null
  readonly judgeModel: ModelRef | null
  readonly taskFilter: ReadonlySet<string> | null
  readonly baseline: string | null
  readonly writeBaseline: boolean
  readonly turnTimeoutMs: number
  readonly startupTimeoutMs: number
}

const envModelRef = (name: string): ModelRef | null => {
  const raw = process.env[name]
  return raw === undefined || raw.length === 0 ? null : parseModelRef(raw)
}

interface ParseState {
  repo: string
  corpus: string
  reps: number
  agentModel: ModelRef | null
  judgeModel: ModelRef | null
  taskFilter: ReadonlySet<string> | null
  baseline: string | null
  writeBaseline: boolean
  turnTimeoutMs: number
  startupTimeoutMs: number
}

const STRING_FLAGS: Readonly<Record<string, (state: ParseState, raw: string) => void>> = {
  '--repo': (state, raw) => {
    state.repo = path.resolve(raw)
  },
  '--corpus': (state, raw) => {
    state.corpus = path.resolve(raw)
  },
  '--tasks': (state, raw) => {
    state.taskFilter = new Set(
      raw
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0),
    )
  },
  '--agent-model': (state, raw) => {
    state.agentModel = parseModelRef(raw)
  },
  '--judge-model': (state, raw) => {
    state.judgeModel = parseModelRef(raw)
  },
  '--baseline': (state, raw) => {
    state.baseline = path.resolve(raw)
  },
}

const NUMBER_FLAGS: Readonly<Record<string, (state: ParseState, raw: number) => void>> = {
  '--reps': (state, raw) => {
    state.reps = raw
  },
  '--turn-timeout-ms': (state, raw) => {
    state.turnTimeoutMs = raw
  },
  '--startup-timeout-ms': (state, raw) => {
    state.startupTimeoutMs = raw
  },
}

const applyFlag = (state: ParseState, flag: string, value: string | undefined): number => {
  const stringHandler = STRING_FLAGS[flag]
  if (stringHandler !== undefined) {
    stringHandler(state, value ?? '')
    return 1
  }
  const numberHandler = NUMBER_FLAGS[flag]
  if (numberHandler !== undefined) {
    numberHandler(state, Number.parseInt(value ?? '', 10))
    return 1
  }
  if (flag === '--write-baseline') {
    state.writeBaseline = true
  }
  return 0
}

export const parseArgs = (argv: readonly string[]): BenchArgs => {
  const state: ParseState = {
    repo: process.cwd(),
    corpus: path.join(process.cwd(), 'bench/agents/corpus.json'),
    reps: 3,
    agentModel: null,
    judgeModel: null,
    taskFilter: null,
    baseline: null,
    writeBaseline: false,
    turnTimeoutMs: 300_000,
    startupTimeoutMs: 30_000,
  }
  for (let index = 0; index < argv.length; index += 1) {
    index += applyFlag(state, argv[index] ?? '', argv[index + 1])
  }
  return {
    repo: state.repo,
    corpus: state.corpus,
    reps: state.reps,
    agentModel: state.agentModel ?? envModelRef('AGENT_BENCH_MODEL'),
    judgeModel: state.judgeModel ?? envModelRef('AGENT_BENCH_JUDGE_MODEL'),
    taskFilter: state.taskFilter,
    baseline: state.baseline,
    writeBaseline: state.writeBaseline,
    turnTimeoutMs: state.turnTimeoutMs,
    startupTimeoutMs: state.startupTimeoutMs,
  }
}
