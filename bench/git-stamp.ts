import { readGitInfo } from '../src/indexer/git-info.js'

export const readRepoHead = (repoRoot: string): string | null => readGitInfo(repoRoot).commit

// A baseline measured against corpus A gates a run against corpus B only by luck. The stamp makes
// the drift loud instead of silent (Slice 8 hit this twice: papai moved mid-slice and the
// committed baselines stopped being reproducible). Missing stamp (legacy baseline) also warns.
export const warnOnCorpusDrift = (
  baselineRepoHead: string | null | undefined,
  currentRepoHead: string | null,
  label: string,
): void => {
  if (baselineRepoHead === currentRepoHead) return
  console.error(
    `WARNING (${label}): baseline corpus drift — baseline stamped ${baselineRepoHead ?? 'nothing'}, current repo HEAD ${currentRepoHead ?? 'unknown'}; the gate comparison is not like-for-like.`,
  )
}
