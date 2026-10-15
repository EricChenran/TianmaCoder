/**
 * The resource readings a node heartbeats. A platform schedules on what a node reports
 * about itself, so these are measured here rather than stated: the disk the coding
 * workspaces live on, the machine's memory, and the CPU time the machine spent between
 * two readings.
 * @module @tianma/dsh-mps-executor/resources
 */

import { existsSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { cpus, freemem, totalmem } from 'node:os'
import { dirname, resolve } from 'node:path'
import type { ExecResources } from '@tianma/dsh-mps-exec-core'

/** Bytes in the gigabytes the protocol states disk space in. */
const BYTES_PER_GB = 1024 * 1024 * 1024

/** One machine's CPU counters at a moment. */
export interface CpuCounters {
  /** Ticks spent not idling across every core. */
  busy: number
  /** Ticks spent idling across every core. */
  idle: number
}

/**
 * One CPU reading, as the counters the host reports.
 * @returns the totals, or undefined when the host reports no times.
 */
export function cpuCounters(): CpuCounters | undefined {
  const cores = cpus()
  let busy = 0
  let idle = 0
  for (const core of cores) {
    busy += core.times.user + core.times.nice + core.times.sys + core.times.irq
    idle += core.times.idle
  }
  return { busy, idle }
}

/**
 * The share of CPU time a machine spent busy between two readings. Without a previous
 * reading the average since boot is what the counters describe, which is the only
 * truthful answer available from one sample.
 * @param previous - the counters read last, when there are any.
 * @param current - the counters read now.
 * @returns the percentage, rounded, or 0 when the counters did not move.
 */
export function cpuPercent(previous: CpuCounters | undefined, current: CpuCounters | undefined): number {
  if (current === undefined) return 0
  const from = previous ?? { busy: 0, idle: 0 }
  const busy = current.busy - from.busy
  const idle = current.idle - from.idle
  const total = busy + idle
  if (total <= 0) return 0
  return Math.round((busy / total) * 100)
}

/** How a resource reading gets its numbers, all injectable for tests. */
export interface ResourceReaderOptions {
  /** Directory whose filesystem is reported; the platform schedules on the disk work lands on. */
  root: string
  /** Free space reader; defaults to the filesystem. */
  freeBytes?: ((root: string) => Promise<number>) | undefined
  /** CPU counters reader; defaults to the host. */
  counters?: (() => CpuCounters | undefined) | undefined
  /** Memory reader; defaults to the host. */
  memory?: (() => { free: number; total: number }) | undefined
}

/** One reader's state: the CPU counters it last saw. */
export interface ResourceReader {
  /** Read the resources once. */
  read: () => Promise<ExecResources>
}

/**
 * Build a reader that measures this machine. Successive readings describe the interval
 * between them, which is what a scheduler wants to see.
 * @param options - the directory to report and the readers to use.
 * @returns the reader.
 */
export function resourceReader(options: ResourceReaderOptions): ResourceReader {
  const readFreeBytes = options.freeBytes ?? freeBytesOf
  const readCounters = options.counters ?? cpuCounters
  const readMemory = options.memory ?? memoryOf
  let previous = readCounters()
  return {
    async read(): Promise<ExecResources> {
      const current = readCounters()
      const percent = cpuPercent(previous, current)
      previous = current
      const memory = readMemory()
      const free = await readFreeBytes(options.root)
      return {
        cpu_percent: percent,
        // The protocol reports what is in use, not what is left.
        mem_percent: memory.total <= 0 ? 0 : Math.round(((memory.total - memory.free) / memory.total) * 100),
        disk_free_gb: Math.round((free / BYTES_PER_GB) * 10) / 10,
      }
    },
  }
}

/**
 * Read the free space of the filesystem a directory sits on.
 * @param root - the directory.
 * @returns the free bytes available to this process.
 */
async function freeBytesOf(root: string): Promise<number> {
  // The root is the coding directory, which the first attempt creates: a reading taken
  // before then has to come from the volume that will hold it. Reporting nothing instead
  // reads as a full disk, and a node that believes its disk is full stops taking work.
  let candidate = resolve(root)
  while (!existsSync(candidate) && dirname(candidate) !== candidate) candidate = dirname(candidate)
  const stats = await statfs(candidate)
  return stats.bavail * stats.bsize
}

/**
 * Read this machine's memory.
 * @returns the total and free bytes.
 */
function memoryOf(): { free: number; total: number } {
  return { free: freemem(), total: totalmem() }
}
