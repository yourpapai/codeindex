export const precisionAtK = (retrieved: readonly string[], relevant: ReadonlySet<string>, k: number): number => {
  if (k <= 0) {
    return 0
  }
  const found = new Set<string>()
  for (const id of retrieved.slice(0, k)) {
    if (relevant.has(id)) {
      found.add(id)
    }
  }
  return found.size / k
}

export const recallAtK = (retrieved: readonly string[], relevant: ReadonlySet<string>, k: number): number => {
  if (relevant.size === 0) {
    return 0
  }
  const found = new Set<string>()
  for (const id of retrieved.slice(0, k)) {
    if (relevant.has(id)) {
      found.add(id)
    }
  }
  return found.size / relevant.size
}

export const reciprocalRank = (retrieved: readonly string[], relevant: ReadonlySet<string>): number => {
  for (let index = 0; index < retrieved.length; index += 1) {
    const id = retrieved[index]
    if (id !== undefined && relevant.has(id)) {
      return 1 / (index + 1)
    }
  }
  return 0
}

export const mean = (values: readonly number[]): number => {
  if (values.length === 0) {
    return 0
  }
  let total = 0
  for (const value of values) {
    total += value
  }
  return total / values.length
}
