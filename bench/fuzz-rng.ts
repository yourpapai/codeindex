export type Rng = () => number

export const createRng = (seed: number): Rng => {
  let state = seed >>> 0
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const randomInt = (rng: Rng, maxExclusive: number): number => Math.floor(rng() * maxExclusive)

export const pick = <T>(rng: Rng, items: readonly T[]): T => {
  const value = items[randomInt(rng, items.length)]
  if (value === undefined) {
    throw new Error('pick called on an empty array')
  }
  return value
}
