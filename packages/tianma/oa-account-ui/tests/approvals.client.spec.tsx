// @vitest-environment jsdom
/**
 * The approvals module: one list, one open document, and the reject guard that
 * keeps an empty comment from reaching the backend.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OaApproval, OaApprovalDetail, OaApprovalType } from '@tianma/dsh-oa-account/types'
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

/** Two categories: one asking for dates, one for the finance columns. */
const TYPES: readonly OaApprovalType[] = [
  {
    id: 1, name: '请假申请', group: 'attendance',
    requiresProject: false, requiresAmount: false, requiresAttachment: false,
    requiresDateRange: true, requiresFlexibleTime: false, defaultApproverIds: [],
  },
  {
    id: 2, name: '报销申请', group: 'finance',
    requiresProject: true, requiresAmount: true, requiresAttachment: true,
    requiresDateRange: false, requiresFlexibleTime: false, defaultApproverIds: [],
  },
]

afterEach(cleanup)

describe('the approvals module', () => {
  it('opens one document and refuses a rejection without a comment', async () => {
    const act = vi.fn(() => Promise.resolve())
    render(<OaApprovalsModule
      t={t}
      loadApprovals={() => Promise.resolve([APPROVAL])}
      loadApproval={() => Promise.resolve(DETAIL)}
      actOnApproval={act}
      loadApprovalTypes={() => Promise.resolve(TYPES)}
      submitApproval={() => Promise.resolve(APPROVAL)}
      saveApprovalDraft={() => Promise.resolve(APPROVAL)}
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

  it('fills the submit form, keeps a draft, then submits the same request', async () => {
    const submit = vi.fn(() => Promise.resolve(APPROVAL))
    const draft = vi.fn(() => Promise.resolve({ ...APPROVAL, status: 'draft' } as OaApproval))
    const view = render(<OaApprovalsModule
      t={t}
      loadApprovals={() => Promise.resolve([])}
      loadApproval={() => Promise.resolve(DETAIL)}
      actOnApproval={() => Promise.resolve()}
      loadApprovalTypes={() => Promise.resolve(TYPES)}
      submitApproval={submit}
      saveApprovalDraft={draft}
    />)

    fireEvent.click(await view.findByRole('button', { name: zh['composeOpen'] }))
    fireEvent.change(await view.findByRole('combobox'), { target: { value: '请假申请' } })
    fireEvent.change(view.getByPlaceholderText(zh['requestTitleHint']), { target: { value: '请假一天' } })
    fireEvent.change(view.getByLabelText(zh['fieldStart']), { target: { value: '2026-11-24' } })
    fireEvent.change(view.getByLabelText(zh['fieldEnd']), { target: { value: '2026-11-25' } })
    fireEvent.change(view.getByLabelText(zh['fieldReason']), { target: { value: '家中有事' } })

    const body = {
      type: '请假申请',
      title: '请假一天',
      content: { reason: '家中有事', start_date: '2026-11-24', end_date: '2026-11-25' },
    }

    fireEvent.click(view.getByRole('button', { name: zh['saveDraft'] }))
    await waitFor(() => { expect(draft).toHaveBeenCalledWith(body) })
    expect(await view.findByText(zh['draftSavedOk'])).toBeTruthy()

    fireEvent.click(view.getByRole('button', { name: zh['submitRequest'] }))
    await waitFor(() => { expect(submit).toHaveBeenCalledWith(body) })
  })
})
