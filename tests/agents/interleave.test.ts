import { describe, expect, test } from 'bun:test'

import { buildSchedule, type ScheduleItem } from '../../bench/agents/run'
import type { TaskSpec } from '../../bench/agents/types'

const task = (id: string): TaskSpec => ({ id, kind: 'locate', prompt: `p-${id}` })

describe('buildSchedule', () => {
  test('alternates arms within each task and covers all reps', () => {
    const schedule = buildSchedule([task('a'), task('b')], 2)
    const aItems = schedule.filter((item: ScheduleItem) => item.task.id === 'a')
    expect(aItems.map((item) => `${item.arm}-${item.rep}`)).toEqual(['with-0', 'without-0', 'with-1', 'without-1'])
  })

  test('does not complete one arm before the other within a task', () => {
    const schedule = buildSchedule([task('a')], 3)
    const arms = schedule.map((item) => item.arm)
    // a sorted copy would group identical arms
    expect(arms).not.toEqual([...arms].sort())
    expect(arms.filter((arm) => arm === 'with')).toHaveLength(3)
    expect(arms.filter((arm) => arm === 'without')).toHaveLength(3)
  })

  test('applies task id filter', () => {
    const schedule = buildSchedule([task('a'), task('b')], 1, new Set(['b']))
    expect(schedule.map((item) => item.task.id)).toEqual(['b', 'b'])
  })

  test('with reps = 0 yields an empty schedule', () => {
    expect(buildSchedule([task('a')], 0)).toEqual([])
  })
})
