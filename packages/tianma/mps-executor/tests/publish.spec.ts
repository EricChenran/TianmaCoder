/**
 * Handing one attempt's work back: what the node refuses before it commits, and what
 * a commit and a push look like once it does — checked once against a recording git
 * and once against real repositories.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, afterEach } from 'vitest'
import {
  GitError,
  PUBLISH_SCAN_MAX_BYTES,
  assertBranchAllowed,
  assertChangesInside,
  changedFiles,
  checkoutPublisher,
  cliGit,
  filesCarryingSecrets,
  publishChanges,
} from '@tianma/dsh-mps-executor'
import type { GitRunner } from '@tianma/dsh-mps-executor'
import { sha256Of } from '@tianma/dsh-mps-exec-core'
import type { ExecTaskAssignment } from '@tianma/dsh-mps-exec-core'

/** Directories one test created, removed after it. */
const created: string[] = []

afterEach(() => {
  for (const directory of created.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/**
 * A directory of its own under the temporary directory.
 * @param prefix - name prefix for the directory.
 * @returns the directory.
 */
function temporary(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix))
  created.push(directory)
  return directory
}

/** A git that records the commands it was given and answers from a script. */
class RecordingGit implements GitRunner {
  readonly calls: string[] = []
  readonly answers = new Map<string, string>()

  async run(_directory: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    const command = args.join(' ')
    this.calls.push(command)
    return { stdout: this.answers.get(command) ?? '', stderr: '' }
  }
}

/** The identity a node commits under. */
const IDENTITY = { name: 'tianma-mps-executor', email: 'node@example.invalid' }

/** One payload as the platform dispatches it, with the policy under test. */
function assignment(policy: Record<string, unknown> = {}): ExecTaskAssignment {
  return {
    task_id: 'tsk_1',
    work_item_id: 'wi_1',
    attempt: 1,
    max_attempts: 3,
    kind: 'coding',
    priority: 400,
    lease_expire_at: '2026-10-15T04:16:00.123+08:00',
    lease_renew_seconds: 30,
    payload: {
      summary: '增加批量下载',
      workspace: { workspace_id: 'ws_1', access_mode: 'read_write' },
      constraints: policy,
    },
  }
}

/** A checkout as the code flow prepared it. */
const CHECKOUT = { base_commit: 'a1b2c3d', work_branch: 'feature/tsk_1' }

describe('changed files', () => {
  it('reports tracked and untracked paths once each, sorted', async () => {
    const git = new RecordingGit()
    git.answers.set('diff --name-only a1b2c3d', 'src/b.ts\nsrc/a.ts\n')
    git.answers.set('ls-files --others --exclude-standard', 'src/a.ts\n报告.md\n')

    expect(await changedFiles(git, 'coding/ws_1', 'a1b2c3d')).toEqual(['src/a.ts', 'src/b.ts', '报告.md'])
  })
})

describe('change checks', () => {
  it('accepts paths inside the workspace', async () => {
    const workspace = temporary('mps-publish-')
    mkdirSync(join(workspace, 'src'), { recursive: true })
    writeFileSync(join(workspace, 'src', 'a.ts'), 'export const a = 1\n', 'utf8')

    await expect(assertChangesInside(workspace, ['src/a.ts', 'src/b.ts', 'gone.ts'])).resolves.toBeUndefined()
  })

  it('refuses an absolute path, a climb out, and a forbidden prefix', async () => {
    const workspace = temporary('mps-publish-')
    mkdirSync(join(workspace, 'src'), { recursive: true })
    const absolute = join(workspace, 'src', 'a.ts')

    await expect(assertChangesInside(workspace, [absolute])).rejects.toThrow(/not a path inside the workspace/)
    await expect(assertChangesInside(workspace, ['../outside.ts'])).rejects.toThrow(/not a path inside the workspace/)
    await expect(assertChangesInside(workspace, ['src/secrets/key.ts'], ['src/secrets'])).rejects.toThrow(/the task forbids/)
    // A pattern that names nothing forbids nothing.
    await expect(assertChangesInside(workspace, ['src/a.ts'], ['', './', '/'])).resolves.toBeUndefined()
  })

  it('refuses a path that resolves outside through a link', async () => {
    const workspace = temporary('mps-publish-')
    const outside = temporary('mps-outside-')
    writeFileSync(join(outside, 'key.ts'), 'const key = 1\n', 'utf8')
    symlinkSync(outside, join(workspace, 'link'), 'junction')

    await expect(assertChangesInside(workspace, ['link/key.ts'])).rejects.toThrow(/resolves outside the workspace/)
    // A path git reports that is gone is judged by the directory it lived in.
    await expect(assertChangesInside(workspace, ['link/gone.ts'])).rejects.toThrow(/resolves outside the workspace/)
  })

  it('refuses a work branch the task pattern does not match', () => {
    expect(() => { assertBranchAllowed('feature/tsk_1', '^feature/.+') }).not.toThrow()
    expect(() => { assertBranchAllowed('main', '^feature/.+') }).toThrow(/branch pattern/)
    expect(() => { assertBranchAllowed('feature/tsk_1', '[') }).toThrow(/is not usable/)
    expect(() => { assertBranchAllowed('anything', undefined) }).not.toThrow()
  })

  it('finds credentials in text and leaves what it cannot judge alone', async () => {
    const workspace = temporary('mps-publish-')
    mkdirSync(join(workspace, 'src'), { recursive: true })
    writeFileSync(join(workspace, 'src', 'leak.ts'), 'const api_key = "abc123"\n', 'utf8')
    writeFileSync(join(workspace, 'src', 'clean.ts'), 'export const a = 1\n', 'utf8')
    writeFileSync(join(workspace, 'src', 'image.bin'), Buffer.from([0x89, 0x00, 0x50, 0x4e, 0x47]))
    writeFileSync(join(workspace, 'src', 'huge.ts'), `token=${'x'.repeat(PUBLISH_SCAN_MAX_BYTES)}`, 'utf8')

    expect(await filesCarryingSecrets(workspace, ['src/leak.ts', 'src/clean.ts', 'src/image.bin', 'src/huge.ts', 'gone.ts']))
      .toEqual(['src/leak.ts'])
  })
})

describe('publishing an attempt', () => {
  it('commits under the robot identity and pushes the work branch', async () => {
    const workspace = temporary('mps-publish-')
    mkdirSync(join(workspace, 'src'), { recursive: true })
    const git = new RecordingGit()
    git.answers.set('diff --name-only a1b2c3d', 'src/a.ts\n')
    git.answers.set('ls-files --others --exclude-standard', '')
    git.answers.set('rev-parse HEAD', 'b2c3d4e\n')

    const published = await publishChanges({
      directory: workspace,
      checkout: CHECKOUT,
      policy: { summary: '增加批量下载' },
      identity: IDENTITY,
      taskId: 'tsk_1',
      git,
    })

    expect(git.calls).toEqual([
      'diff --name-only a1b2c3d',
      'ls-files --others --exclude-standard',
      'add --all',
      '-c user.name=tianma-mps-executor -c user.email=node@example.invalid commit --quiet -m 增加批量下载',
      'rev-parse HEAD',
      'push origin feature/tsk_1',
    ])
    expect(published).toEqual({ changed_files: ['src/a.ts'], head_commit: 'b2c3d4e', pushed: true })
  })

  it('names the commit after the task when the payload states no summary', async () => {
    const workspace = temporary('mps-publish-')
    const git = new RecordingGit()
    git.answers.set('diff --name-only a1b2c3d', 'a.ts\n')
    git.answers.set('rev-parse HEAD', 'b2c3d4e\n')

    await publishChanges({ directory: workspace, checkout: CHECKOUT, policy: {}, identity: IDENTITY, taskId: 'tsk_1', git })

    expect(git.calls).toContain('-c user.name=tianma-mps-executor -c user.email=node@example.invalid commit --quiet -m task tsk_1')
  })

  it('commits without pushing when the task does not require a push', async () => {
    const workspace = temporary('mps-publish-')
    const git = new RecordingGit()
    git.answers.set('diff --name-only a1b2c3d', 'a.ts\n')
    git.answers.set('rev-parse HEAD', 'b2c3d4e\n')

    const published = await publishChanges({
      directory: workspace,
      checkout: CHECKOUT,
      policy: { push_required: false },
      identity: IDENTITY,
      taskId: 'tsk_1',
      git,
    })

    expect(published.pushed).toBe(false)
    expect(git.calls.some(call => call.startsWith('push'))).toBe(false)
  })

  it('leaves an attempt that changed nothing alone', async () => {
    const workspace = temporary('mps-publish-')
    const git = new RecordingGit()

    const published = await publishChanges({ directory: workspace, checkout: CHECKOUT, policy: {}, identity: IDENTITY, taskId: 'tsk_1', git })

    expect(published).toEqual({ changed_files: [], head_commit: 'a1b2c3d', pushed: false })
    expect(git.calls.some(call => call.startsWith('add') || call.startsWith('-c'))).toBe(false)
  })

  it('refuses credentials before it commits anything', async () => {
    const workspace = temporary('mps-publish-')
    writeFileSync(join(workspace, 'leak.txt'), 'password: hunter2\n', 'utf8')
    const git = new RecordingGit()
    git.answers.set('diff --name-only a1b2c3d', 'leak.txt\n')

    await expect(publishChanges({ directory: workspace, checkout: CHECKOUT, policy: {}, identity: IDENTITY, taskId: 'tsk_1', git }))
      .rejects.toThrow(/refusing to publish credentials in leak.txt/)
    expect(git.calls).toEqual(['diff --name-only a1b2c3d', 'ls-files --others --exclude-standard'])
  })

  it('refuses a change that leaves the workspace before it commits anything', async () => {
    const workspace = temporary('mps-publish-')
    const git = new RecordingGit()
    git.answers.set('diff --name-only a1b2c3d', '../outside.ts\n')

    await expect(publishChanges({ directory: workspace, checkout: CHECKOUT, policy: {}, identity: IDENTITY, taskId: 'tsk_1', git }))
      .rejects.toThrow(/not a path inside the workspace/)
  })

  it('skips the workspace check only when the task states it does not need it', async () => {
    const workspace = temporary('mps-publish-')
    const git = new RecordingGit()
    git.answers.set('diff --name-only a1b2c3d', '../outside.ts\n')
    git.answers.set('rev-parse HEAD', 'b2c3d4e\n')

    const published = await publishChanges({
      directory: workspace,
      checkout: CHECKOUT,
      policy: { must_stay_in_workspace: false },
      identity: IDENTITY,
      taskId: 'tsk_1',
      git,
    })

    expect(published.changed_files).toEqual(['../outside.ts'])
  })

  it('bundles a read_only attempt instead of pushing it', async () => {
    const workspace = temporary('mps-publish-')
    const git = new RecordingGit()
    git.answers.set('diff --name-only a1b2c3d', 'a.ts\n')
    git.answers.set('rev-parse HEAD', 'b2c3d4e\n')
    // The recording git writes nothing, so the bundle the publisher digests is here.
    mkdirSync(join(workspace, '.bundles'), { recursive: true })
    writeFileSync(join(workspace, '.bundles', 'feature-tsk_1-b2c3d4e.bundle'), 'bundle bytes', 'utf8')

    const published = await publishChanges({
      directory: workspace,
      checkout: CHECKOUT,
      policy: { access_mode: 'read_only' },
      identity: IDENTITY,
      taskId: 'tsk_1',
      git,
    })

    expect(git.calls).toContain(
      `bundle create ${join('.bundles', 'feature-tsk_1-b2c3d4e.bundle')} feature/tsk_1 --not a1b2c3d`,
    )
    expect(git.calls).not.toContain('push origin feature/tsk_1')
    expect(published.pushed).toBe(false)
    expect(published.bundle?.path).toBe(join('.bundles', 'feature-tsk_1-b2c3d4e.bundle'))
    expect(published.bundle?.sha256).toBe(sha256Of(Buffer.from('bundle bytes')))
  })

  it('hands a runner the same publish step through the port', async () => {
    const workspace = temporary('mps-publish-')
    const git = new RecordingGit()
    git.answers.set('diff --name-only a1b2c3d', 'a.ts\n')
    git.answers.set('rev-parse HEAD', 'b2c3d4e\n')
    const publisher = checkoutPublisher({ git, identity: IDENTITY })

    const published = await publisher.publish({
      assignment: assignment({ branch_pattern: '^feature/.+' }),
      directory: workspace,
      checkout: CHECKOUT,
    })

    expect(published).toEqual({ changed_files: ['a.ts'], head_commit: 'b2c3d4e', pushed: true })
    expect(git.calls).toContain('push origin feature/tsk_1')
  })
})

describe('publishing against real repositories', () => {
  /** A bare repository the node can push to, and the directory it pushes from. */
  async function workspaceWithChange(git: GitRunner): Promise<{ workspace: string; bare: string }> {
    const bare = temporary('mps-bare-')
    await git.run(bare, ['init', '--bare', '--quiet'])
    const workspace = temporary('mps-work-')
    await git.run(workspace, ['init', '--quiet'])
    writeFileSync(join(workspace, 'readme.md'), 'base\n', 'utf8')
    await git.run(workspace, ['add', 'readme.md'])
    await git.run(workspace, ['-c', 'user.name=Setup', '-c', 'user.email=setup@example.invalid', 'commit', '--quiet', '-m', 'base'])
    await git.run(workspace, ['remote', 'add', 'origin', bare])
    await git.run(workspace, ['checkout', '--quiet', '-b', 'feature/tsk_1'])
    return { workspace, bare }
  }

  it('commits under the injected identity and pushes to the remote', async () => {
    const git = cliGit()
    const { workspace, bare } = await workspaceWithChange(git)
    writeFileSync(join(workspace, 'readme.md'), 'base\nand more\n', 'utf8')
    writeFileSync(join(workspace, 'report.md'), '# 报告\n', 'utf8')

    const published = await publishChanges({
      directory: workspace,
      checkout: { base_commit: (await git.run(workspace, ['rev-parse', 'HEAD'])).stdout.trim(), work_branch: 'feature/tsk_1' },
      policy: { summary: '增加批量下载' },
      identity: IDENTITY,
      taskId: 'tsk_1',
      git,
    })

    expect(published.changed_files).toEqual(['readme.md', 'report.md'])
    expect(published.pushed).toBe(true)
    const author = (await git.run(workspace, ['log', '-1', '--format=%an <%ae> %s'])).stdout.trim()
    expect(author).toBe('tianma-mps-executor <node@example.invalid> 增加批量下载')
    // The identity is injected per command, so the repository keeps none.
    expect((await git.run(workspace, ['config', '--local', '--get', 'user.name']).catch(() => ({ stdout: '' }))).stdout).toBe('')
    const pushed = (await git.run(bare, ['rev-parse', 'feature/tsk_1'])).stdout.trim()
    expect(pushed).toBe(published.head_commit)
  })

  it('hands a read_only attempt back as a bundle the platform can fetch', async () => {
    const git = cliGit()
    const { workspace, bare } = await workspaceWithChange(git)
    const base = (await git.run(workspace, ['rev-parse', 'HEAD'])).stdout.trim()
    // The platform's own clone already holds the baseline; only the work is new.
    await git.run(workspace, ['push', '--quiet', 'origin', `${base}:refs/heads/base`])
    writeFileSync(join(workspace, 'readme.md'), 'base\nread_only 的改动\n', 'utf8')

    const published = await publishChanges({
      directory: workspace,
      checkout: { base_commit: base, work_branch: 'feature/tsk_1' },
      policy: { access_mode: 'read_only', summary: '只读模式交付' },
      identity: IDENTITY,
      taskId: 'tsk_1',
      git,
    })

    expect(published.pushed).toBe(false)
    expect(published.changed_files).toEqual(['readme.md'])
    // Nothing reached the remote, and the bundle is not part of the commit.
    await expect(git.run(bare, ['rev-parse', 'feature/tsk_1'])).rejects.toThrow(/unknown revision|ambiguous argument/u)
    const committed = (await git.run(workspace, ['show', '--name-only', '--format=', 'HEAD'])).stdout.trim().split('\n')
    expect(committed).toEqual(['readme.md'])
    expect(existsSync(join(workspace, '.git', 'info', 'exclude'))).toBe(true)
    expect((await git.run(workspace, ['check-ignore', '.bundles/x.bundle'])).stdout.trim()).toBe('.bundles/x.bundle')

    // A fresh clone of the remote can take the change out of the bundle.
    const reader = temporary('mps-reader-')
    await git.run(reader, ['clone', '--quiet', bare, '.'])
    await git.run(reader, ['fetch', '--quiet', join(workspace, published.bundle?.path ?? ''), 'feature/tsk_1:refs/heads/handed-back'])
    expect((await git.run(reader, ['log', '-1', '--format=%s', 'handed-back'])).stdout.trim()).toBe('只读模式交付')
    expect((await git.run(reader, ['show', 'handed-back:readme.md'])).stdout).toBe('base\nread_only 的改动\n')
  })

  it('leaves no commit behind when a change carries a credential', async () => {
    const git = cliGit()
    const { workspace } = await workspaceWithChange(git)
    const before = (await git.run(workspace, ['rev-parse', 'HEAD'])).stdout.trim()
    writeFileSync(join(workspace, 'leak.env'), 'MPS_NODE_SECRET=abcdef123456\n', 'utf8')

    await expect(publishChanges({
      directory: workspace,
      checkout: { base_commit: before, work_branch: 'feature/tsk_1' },
      policy: {},
      identity: IDENTITY,
      taskId: 'tsk_1',
      git,
    })).rejects.toThrow(/refusing to publish credentials/)

    expect((await git.run(workspace, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(before)
    expect(existsSync(join(workspace, 'leak.env'))).toBe(true)
  })

  it('reports a push that the remote refuses', async () => {
    const git = cliGit()
    const { workspace } = await workspaceWithChange(git)
    await git.run(workspace, ['remote', 'set-url', 'origin', join(tmpdir(), 'mps-absent-remote')])
    writeFileSync(join(workspace, 'readme.md'), 'changed\n', 'utf8')

    await expect(publishChanges({
      directory: workspace,
      checkout: { base_commit: (await git.run(workspace, ['rev-parse', 'HEAD'])).stdout.trim(), work_branch: 'feature/tsk_1' },
      policy: {},
      identity: IDENTITY,
      taskId: 'tsk_1',
      git,
    })).rejects.toThrow(GitError)
    // The commit happened; only the push failed, which the platform retries.
    expect((await git.run(workspace, ['log', '-1', '--format=%s'])).stdout.trim()).toBe('task tsk_1')
  })
})
