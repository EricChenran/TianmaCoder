/**
 * The Tianma MPS executor node as a dsh plugin: it reads the management
 * platform's communication address from its profile row, authenticates with the
 * pre-shared secret, registers this machine's identity and capacity, and keeps
 * the heartbeat that carries commands down from the platform. The node process is
 * a profile — `dsh --profile <node profile>` — so this plugin is the profile's
 * application, not a second binary spawned beside it.
 * @module @tianma/dsh-mps-executor
 */

import type { Context } from '@deepseek-ai/cordis'
import { tianmaCliRunner } from './cli-runner.ts'
import { readNodeSecret, resolveExecutorSettings } from './config.ts'
import type { Config } from './config.ts'
import { MpsExecutorRuntime } from './runtime.ts'
import type { ExecutorReport } from './runtime.ts'
import type { TaskRunner } from './runner.ts'

export {
  Config,
  DEFAULT_CLAIM_LONG_POLL_SECONDS,
  DEFAULT_GIT_USER_EMAIL,
  DEFAULT_GIT_USER_NAME,
  DEFAULT_HEARTBEAT_SECONDS,
  DEFAULT_LEASE_RENEW_SECONDS,
  DEFAULT_MAX_ARTIFACT_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SECRET_ENV,
  DEFAULT_TASK_RUNTIME_SECONDS,
  UNKNOWN_AGENT_VERSION,
  readNodeSecret,
  resolveExecutorSettings,
} from './config.ts'
export { MpsExecutorRuntime } from './runtime.ts'
export type { ExecutorReport, NodeState } from './runtime.ts'
export type { ExecutorRuntimeOptions } from './runtime.ts'
export type { ExecutorSettings } from './config.ts'
export { LOG_BATCH_MAX_LINES, LOG_LINE_MAX_BYTES, TaskOrchestrator, boundLogLine } from './orchestrator.ts'
export type { TaskOrchestratorHooks, TaskOrchestratorOptions, TaskPlatformClient } from './orchestrator.ts'
export { toError } from './report.ts'
export type {
  PublishedChanges,
  TaskCheckout,
  TaskRunContext,
  TaskRunResult,
  TaskRunner,
  TaskRunnerSource,
  TaskWorkspace,
  TaskWorkspaceAllocator,
} from './runner.ts'
export { GitError, cliGit } from './git.ts'
export type { GitOutput, GitRunner } from './git.ts'
export { checkoutAllocator, prepareCheckout } from './checkout.ts'
export type { CheckoutAllocatorOptions, PrepareCheckoutOptions } from './checkout.ts'
export {
  PUBLISH_SCAN_MAX_BYTES,
  assertBranchAllowed,
  BUNDLE_DIRECTORY,
  assertChangesInside,
  changedFiles,
  checkoutPublisher,
  filesCarryingSecrets,
  publishChanges,
} from './publish.ts'
export {
  RUNNER_STOP_GRACE_MS,
  stopPlan,
  exitCodeOf,
  readRunEvent,
  runFailureSummary,
  shellFor,
  stopRun,
  tianmaCliRunner,
} from './cli-runner.ts'
export type { RunEvent, StoppableRun, StopPlan } from './cli-runner.ts'
export { DEFAULT_CLI_COMMAND } from './config.ts'
export { TASK_BOOK_FILE, TASK_BOOK_POINTER, taskBook, writeTaskBook } from './task-book.ts'
export {
  EVIDENCE_DIRECTORY,
  SCREENSHOT_MANIFEST,
  SCREENSHOTS_DIRECTORY,
  SCREENSHOT_MIN_HEIGHT,
  SCREENSHOT_MIN_WIDTH,
  collectEvidence,
} from './evidence.ts'
export { MATERIALS_DIRECTORY, fetchMaterials, materialFileName, taskMaterials } from './materials.ts'
export type {
  CollectEvidenceOptions,
  CollectedEvidence,
  EvidenceCommand,
  EvidenceCommandOutcome,
  EvidenceFailure,
  EvidenceScreenshot,
} from './evidence.ts'
export type { FetchMaterialsOptions, MaterialFile, MaterialSource } from './materials.ts'
export type { CliRunnerOptions } from './cli-runner.ts'
export type {
  CheckoutPublisherOptions,
  GitIdentity,
  PublishChangesOptions,
  TaskPublisher,
  TaskPublishRequest,
} from './publish.ts'
export { WORKSPACE_STATE_FILE, WORKSPACE_STATE_VERSION, WorkspaceStore } from './workspace.ts'
export type { WorkspaceRecord, WorkspaceSession, WorkspaceStoreOptions } from './workspace.ts'
export { checkoutSessionReporter, restoredSessionReports } from './session.ts'
export {
  ARTIFACT_CHUNK_SIZE_BYTES,
  ARTIFACT_CHUNK_THRESHOLD_BYTES,
  clientArtifactUploader,
} from './artifacts.ts'
export type {
  ArtifactPlatformClient,
  ArtifactUploaderOptions,
  TaskArtifactRequest,
  TaskArtifactUploader,
} from './artifacts.ts'
export { excludeFromRepository, isInside, resolveWithinWorkspace } from './paths.ts'
export type {
  CheckoutSessionReporterOptions,
  RestoredSessionReport,
  SessionPlatformClient,
  TaskSessionReporter,
  TaskSessionRequest,
} from './session.ts'
// The runtime's transport option is an exec-core type, so a caller that injects a
// transport needs it reachable without depending on the wire package directly.
export type { ExecHttpRequest, ExecHttpResponse, ExecHttpTransport } from '@tianma/dsh-mps-exec-core'

/** Stable Cordis plugin name. */
export const name = 'tianma-mps-executor'

/** Cordis service key a composed task runner publishes under. */
export const TASK_RUNNER_SERVICE = 'mpsTaskRunner'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The executor node's platform session. */
    mpsExecutor: MpsExecutorRuntime
    /** Executes this node's claimed attempts; published by whichever runner plugin is composed. */
    mpsTaskRunner: TaskRunner
  }
}

/** The logging methods a node event is routed through. */
export interface ExecutorLogger {
  /** Record an ordinary event. */
  info(message: string): void
  /** Record a condition the node retries or waits out. */
  warn(message: string): void
  /** Record a failure an operator must act on. */
  error(message: string): void
}

/**
 * Build the report sink that routes node events to the profile's logger.
 * @param logger - the node's named logger.
 * @returns the sink the runtime reports through.
 */
export function createReportSink(logger: ExecutorLogger): (report: ExecutorReport) => void {
  return (report: ExecutorReport) => {
    if (report.level === 'error') logger.error(report.message)
    else if (report.level === 'warn') logger.warn(report.message)
    else logger.info(report.message)
  }
}

/**
 * Restore the coding workspaces this node kept, then start its handshake and, once
 * the node is registered, its heartbeat. A handshake that fails leaves the node
 * unregistered; the report sink already carried the reason, so nothing further is
 * retried here.
 * @param runtime - the node runtime to start.
 */
export function autoStartNode(runtime: MpsExecutorRuntime): void {
  runtime.restore()
    .then(() => runtime.bootstrap())
    .then(
      () => { runtime.start() },
      () => { /* restore or bootstrap reported the failure that ended the handshake */ },
    )
}

/**
 * Register the node's stop as a plugin effect, so unloading the profile stops
 * the heartbeat instead of leaving a timer behind.
 * @param ctx - the Cordis context the plugin mounts in.
 * @param runtime - the runtime to stop.
 * @returns the stop function the effect disposes with.
 */
export function registerStopEffect(ctx: Context, runtime: MpsExecutorRuntime): () => void {
  const stop = (): void => { runtime.stop() }
  ctx.effect(() => stop)
  return stop
}

/**
 * Mount the node: resolve its platform address, read its secret, publish the
 * runtime as `ctx.mpsExecutor`, and start the handshake when the configuration
 * asks for it. The runtime stops with the plugin.
 * @param ctx - the Cordis context the plugin mounts in.
 * @param config - the validated node configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const settings = resolveExecutorSettings(config)
  // The node's own runner, used when nothing composes one under the service key. A
  // deployment that wants a different execution strategy composes its own provider
  // and this one is never reached.
  const ownRunner = tianmaCliRunner({
    command: settings.cliRunner.command,
    logsDirectory: settings.cliRunner.logsDirectory,
    env: settings.cliRunner.dshHome === undefined ? undefined : { DSH_HOME: settings.cliRunner.dshHome },
    jsonEvents: settings.cliRunner.jsonEvents,
  })
  const runtime = new MpsExecutorRuntime({
    settings,
    // Read when the handshake starts: the profile loads, and its help prints,
    // before the deployment has to provide the credential.
    secret: () => readNodeSecret(config),
    // Read when the node starts claiming, so a runner composed by any other row
    // is found even when it mounts after this one.
    runner: () => ctx.get(TASK_RUNNER_SERVICE) ?? ownRunner,
    report: createReportSink(ctx.logger('mps-executor')),
  })
  ctx.provide('mpsExecutor', runtime)
  registerStopEffect(ctx, runtime)
  if (settings.autoStart) autoStartNode(runtime)
}
