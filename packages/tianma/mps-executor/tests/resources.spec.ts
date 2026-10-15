/**
 * The readings a node heartbeats. A platform schedules on them, so they describe the
 * machine as it is: the disk the work lands on, the memory in use, and the CPU time spent
 * between two readings.
 */

import { describe, expect, it } from 'vitest'
import { cpuCounters, cpuPercent, resourceReader } from '@tianma/dsh-mps-executor'

describe('reading CPU time', () => {
  it('describes the interval between two readings', () => {
    // Half the ticks between the readings were busy.
    expect(cpuPercent({ busy: 100, idle: 100 }, { busy: 150, idle: 150 })).toBe(50)
    expect(cpuPercent({ busy: 100, idle: 100 }, { busy: 300, idle: 100 })).toBe(100)
    expect(cpuPercent({ busy: 100, idle: 100 }, { busy: 100, idle: 300 })).toBe(0)
  })

  it('describes the time since boot when there is no earlier reading', () => {
    expect(cpuPercent(undefined, { busy: 25, idle: 75 })).toBe(25)
  })

  it('reports nothing when the counters did not move or the host has none', () => {
    expect(cpuPercent({ busy: 5, idle: 5 }, { busy: 5, idle: 5 })).toBe(0)
    expect(cpuPercent(undefined, undefined)).toBe(0)
  })

  it('reads this machine counters', () => {
    const counters = cpuCounters()

    // A host always reports times for the cores it schedules on.
    expect(counters).toBeDefined()
    expect(counters?.busy).toBeGreaterThan(0)
    expect(counters?.idle).toBeGreaterThanOrEqual(0)
  })
})

describe('reading the resources of one machine', () => {
  it('reports the memory in use, the free disk, and the CPU interval', async () => {
    const counters = [
      { busy: 100, idle: 100 },
      { busy: 200, idle: 300 },
      { busy: 400, idle: 400 },
    ]
    let reading = -1
    const reader = resourceReader({
      root: 'D:\\mps\\coding',
      counters: () => counters[Math.min(reading += 1, counters.length - 1)],
      memory: () => ({ free: 4 * 1024 ** 3, total: 16 * 1024 ** 3 }),
      freeBytes: async (root) => {
        expect(root).toBe('D:\\mps\\coding')
        return 5.25 * 1024 ** 3
      },
    })

    const first = await reader.read()
    const second = await reader.read()

    // The first reading has no interval to describe, the second one does.
    expect(first.cpu_percent).toBe(33)
    expect(second.cpu_percent).toBe(67)
    expect(second.mem_percent).toBe(75)
    expect(second.disk_free_gb).toBe(5.3)
  })

  it('reads the filesystem the work lands on and this machine memory', async () => {
    const reader = resourceReader({ root: process.cwd() })

    const reading = await reader.read()

    expect(reading.disk_free_gb).toBeGreaterThanOrEqual(0)
    expect(reading.mem_percent).toBeGreaterThanOrEqual(0)
    expect(reading.mem_percent).toBeLessThanOrEqual(100)
    expect(reading.cpu_percent).toBeGreaterThanOrEqual(0)
    expect(reading.cpu_percent).toBeLessThanOrEqual(100)
  })

  it('reports no memory in use when the host reports no memory at all', async () => {
    const reader = resourceReader({
      root: '.',
      counters: () => undefined,
      memory: () => ({ free: 0, total: 0 }),
      freeBytes: async () => 0,
    })

    expect(await reader.read()).toEqual({ cpu_percent: 0, mem_percent: 0, disk_free_gb: 0 })
  })
})
