// @vitest-environment jsdom
/**
 * The workbench panel itself: seven module tabs, a message opened beside its
 * list, and the read call that opening one makes.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { OaMessage } from '@tianma/dsh-oa-account/types'
import { OaWorkbenchPanel } from '../src/client/workbench/Workbench.tsx'
import { zh } from '../src/client/workbench/locales.ts'
import type { OaWorkbenchSnapshot } from '../src/client/contract.ts'

const t = (key: keyof typeof zh): string => zh[key]

const MESSAGE: OaMessage = {
  id: 31,
  kind: 'approval-request',
  summary: '张三 提交了《请假申请》审批，请处理',
  time: '今天 09:30',
  unread: true,
  payload: { approvalId: 18, approvalTitle: '请假申请', applicantName: '张三' },
}

const snapshot = (unread: readonly OaMessage[]): OaWorkbenchSnapshot => ({
  signedIn: true,
  stats: { value: undefined, loading: false, error: undefined },
  messages: { value: unread, loading: false, error: undefined },
  todos: { value: [], loading: false, error: undefined },
  attendance: { value: undefined, loading: false, error: undefined },
  notifications: { value: undefined, loading: false, error: undefined },
})

describe('the workbench panel', () => {
  it('offers every module and opens a message beside its list', async () => {
    const readMessage = vi.fn(() => Promise.resolve())
    const props = {
      useOaWorkbench: () => snapshot([MESSAGE]),
      t,
      openLogin: () => {},
      refresh: () => Promise.resolve(),
      readMessage,
      readAllMessages: () => Promise.resolve(),
      createTodo: () => Promise.resolve(),
      toggleTodo: () => Promise.resolve(),
      checkIn: () => Promise.resolve(),
      checkOut: () => Promise.resolve(),
      setPreference: () => Promise.resolve(),
      loadApprovals: () => Promise.resolve([]),
      loadApproval: () => Promise.reject(new Error('not opened here')),
      actOnApproval: () => Promise.resolve(),
      loadSchedules: () => Promise.resolve([]),
      loadTaskBoard: () => Promise.resolve([]),
      completeTask: () => Promise.resolve(),
      loadAttendanceSummary: () => Promise.reject(new Error('not opened here')),
    }

    render(<OaWorkbenchPanel {...(props as never)} />)

    // One tab per module, named by the dictionary.
    for (const label of [
      zh['moduleOverview'], zh['moduleMessages'], zh['moduleApproval'],
      zh['moduleTodos'], zh['moduleSchedules'], zh['moduleTasks'], zh['moduleAttendance'],
    ]) {
      expect(screen.getByRole('tab', { name: new RegExp(label) })).toBeTruthy()
    }

    fireEvent.click(screen.getByRole('tab', { name: new RegExp(zh['moduleMessages']) }))
    fireEvent.click(await screen.findByText(MESSAGE.summary))

    // Opening an unread message marks it read and opens a second-level tab.
    await waitFor(() => { expect(readMessage).toHaveBeenCalledWith(31) })
    expect(screen.getAllByRole('tab', { name: new RegExp('张三 提交了') }).length).toBeGreaterThan(0)
    expect(screen.getByText(MESSAGE.payload.approvalTitle ?? '')).toBeTruthy()
  })
})
