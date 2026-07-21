export interface GitInfo {
  readonly commit: string | null
  readonly branch: string | null
}

const runGit = (args: readonly string[], repoRoot: string): string | null => {
  try {
    const result = Bun.spawnSync(['git', ...args], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0) {
      return null
    }
    const text = result.stdout.toString().trim()
    return text.length > 0 ? text : null
  } catch {
    return null
  }
}

export const readGitInfo = (repoRoot: string): GitInfo => {
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot)
  return {
    commit: runGit(['rev-parse', 'HEAD'], repoRoot),
    branch: branch === 'HEAD' ? null : branch,
  }
}
