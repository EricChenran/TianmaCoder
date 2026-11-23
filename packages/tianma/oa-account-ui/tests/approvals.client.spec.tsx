// @vitest-environment jsdom
/**
 * The approvals module: one list, one open document, and the reject guard that
 * keeps an empty comment from reaching the backend.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { OaApproval, OaApprovalDetail } from '@tianma/dsh-oa-account/types'
import { OaApprovalsModule } from '../src/client/workbench/Approvals.tsx'
import { zh } from '../src/client/workbench/locales.ts'

const t = (key: keyof typeof zh): string => zh[key]

const APPROVAL: OaApproval = {
  id: 18,
  title: '请假申请',
  type: '请假申请',
  department: '技术部',
  projectName: null,
  projectNo: null,
  createdAt: '2026年11月23日 09:30',
  applicantName: '张三',
  applicantAvatar: '',
  arrivalTime: '2小时前到达',
  status: 'pending',
  content: { start_date: '2026-11-24', end_date: '2026-11-25', reason: '家中有事' },
  currentLevel: 1,
  totalLevels: 2,
  nodes: [{ id: 30, level: 1, state: 'pending', comment: null, approverName: '陈祖豪', approverAvatar: '', approvedAt: null }],
  ccUsers: [],
}

const DETAIL: OaApprovalDetail = {
  ...APPROVAL,
  canApprove: true,
  isCc: false,
  canCancel: false,
  cancelDisabledReason: null,
}

describe('the approvals module', () => {
  it('opens one document and refuses a rejection without a comment', async () => {
    const act = vi.fn(() => Promise.resolve())
    render(<OaApprovalsModule
      t={t}
      loadApprovals={() => Promise.resolve([APPROVAL])}
      loadApproval={() => Promise.resolve(DETAIL)}
      actOnApproval={act}
    />)

    fireEvent.click(await screen.findByText('请假申请'))
    expect(await screen.findByText('2026-11-24')).toBeTruthy()
    expect(screen.getByText('陈祖豪')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: zh['reject'] }))
    expect(await screen.findByText(zh['rejectNeedsComment'])).toBeTruthy()
    expect(act).not.toHaveBeenCalled()

    fireEvent.change(screen.getByPlaceholderText(zh['commentHint']), { target: { value: '同意，注意交接' } })
    fireEvent.click(screen.getByRole('button', { name: zh['approve'] }))
    await waitFor(() => {
      expect(act).toHaveBeenCalledWith({ id: 18, action: 'approve', comment: '同意，注意交接' })
    })
  })
})
