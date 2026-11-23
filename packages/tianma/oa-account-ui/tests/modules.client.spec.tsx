// @vitest-environment jsdom
/**
 * The schedule and task modules: one read each, and the completion write that
 * reloads the board it acted on.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { OaSchedule, OaTaskGroup } from '@tianma/dsh-oa-account/types'
import { OaSchedulesModule, OaTasksModule } from '../src/client/workbench/Modules.tsx'
import { zh } from '../src/client/workbench/locales.ts'

const t = (key: keyof typeof zh): string => zh[key]

const EVENT: OaSchedule = {
  id: '21',
  kind: 'event',
  title: '项目评审会',
  text: '项目评审会',
  startTime: '14:00:00',
  endTime: '15:30:00',
  location: '3 楼会议室',
  myInvite: 'accepted',
  mine: true,
}

const LEAVE: OaSchedule = {
  id: 'approval-55-2026-11-23',
  kind: 'leave',
  title: '王五 调休',
  text: '王五调休',
  startTime: null,
  endTime: null,
  location: '调休',
  myInvite: null,
  mine: false,
}

const BOARD: OaTaskGroup[] = [{
  name: '今天',
  count: 1,
  tasks: [{
    id: 12,
    title: '整理报价单',
    typeLabel: '系统任务',
    deadline: '11月23日 18:00',
    overdue: false,
    status: 'ongoing',
    estimatedHours: 4,
    actualHours: 0,
    description: '',
    assignees: [],
  }],
}]

describe('the schedule module', () => {
  it('shows a meeting and marks a derived leave line', async () => {
    render(<OaSchedulesModule t={t} loadSchedules={() => Promise.resolve([EVENT, LEAVE])} />)
    expect(await screen.findByText('项目评审会')).toBeTruthy()
    expect(screen.getByText('王五 调休')).toBeTruthy()
    // A leave line is the only entry that carries the leave tag.
    expect(screen.getByText(zh['leaveCount'])).toBeTruthy()
  })
})

describe('the task module', () => {
  it('completes one task and reloads the board', async () => {
    const load = vi.fn(() => Promise.resolve(BOARD))
    const complete = vi.fn(() => Promise.resolve())
    render(<OaTasksModule t={t} loadTaskBoard={load} completeTask={complete} />)
    await screen.findByText('整理报价单')
    fireEvent.click(screen.getByLabelText(zh['done']))
    await waitFor(() => { expect(complete).toHaveBeenCalledWith(12) })
    // The board is re-read after the write, so the row reflects the backend.
    await waitFor(() => { expect(load).toHaveBeenCalledTimes(2) })
  })
})
