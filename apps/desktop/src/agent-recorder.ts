/** Canvas recorder carrier: guest frames are drawn onto a page canvas and encoded as WebM. */
import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { WebContentsView, app } from 'electron'

/** One finished recording. */
export interface AgentRecordingResult {
  /** WebM bytes as base64. */
  readonly base64: string
  /** Frames the page drew into the recording. */
  readonly frames: number
  /** Recording duration in milliseconds. */
  readonly durationMs: number
}

/** Recorder carrier the shell drives; tests substitute a deterministic one. */
export interface AgentRecorderPort {
  /** Install the recording page and start accepting frames. */
  start(frameIntervalMs: number): Promise<void>
  /** Draw one captured guest frame. */
  frame(png: Buffer): Promise<void>
  /** @returns The encoded WebM and its frame count, or `undefined` when nothing was recorded. */
  stop(): Promise<AgentRecordingResult | undefined>
  /** Close the recording page. */
  dispose(): Promise<void>
}

/** Default frame interval: five frames per second keeps the file small and the pump cheap. */
export const AGENT_RECORD_FRAME_INTERVAL_MS = 200

/** Recordings older than this are deleted when a new recording starts. */
export const AGENT_RECORDING_TTL_MS = 24 * 60 * 60 * 1_000

/** @returns The directory finished recordings default to. */
export function agentRecordingsDir(): string {
  return app.getPath('userData')
}

/**
 * Build the recording document. The page owns a canvas fed by captured guest
 * frames and encodes it with `MediaRecorder`, so a hidden or minimized window
 * still records: nothing here depends on display capture.
 * @returns A self-contained HTML document.
 */
function recorderDocument(): string {
  return `<!doctype html><html><body><script>
const canvas = document.createElement('canvas');
const context = canvas.getContext('2d');
let recorder;
let chunks = [];
let frames = 0;
let startedAt = 0;
globalThis.__frame = (dataUrl) => new Promise((resolve) => {
  const image = new Image();
  image.onload = () => {
    if (canvas.width !== image.width || canvas.height !== image.height) {
      canvas.width = image.width;
      canvas.height = image.height;
    }
    context.drawImage(image, 0, 0);
    frames += 1;
    resolve(true);
  };
  image.onerror = () => { resolve(false); };
  image.src = dataUrl;
});
globalThis.__start = (intervalMs) => {
  chunks = [];
  frames = 0;
  startedAt = Date.now();
  const stream = canvas.captureStream(Math.max(1, Math.round(1000 / intervalMs)));
  recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8' });
  recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
  recorder.start(1000);
  return true;
};
globalThis.__stop = () => new Promise((resolve) => {
  if (!recorder) { resolve(null); return; }
  const active = recorder;
  recorder = undefined;
  active.onstop = async () => {
    const blob = new Blob(chunks, { type: 'video/webm' });
    if (blob.size === 0) { resolve(null); return; }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
    resolve({ base64: btoa(binary), frames: frames, durationMs: Date.now() - startedAt });
  };
  active.stop();
});
</script></body></html>`
}

/** @returns the production recorder: one offscreen page that draws frames and encodes WebM. */
export function createCanvasRecorder(): AgentRecorderPort {
  const view = new WebContentsView({
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      webviewTag: false, plugins: false, backgroundThrottling: false, devTools: !app.isPackaged,
    },
  })
  const web = view.webContents
  return {
    async start(frameIntervalMs: number): Promise<void> {
      await web.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(recorderDocument())}`)
      await web.executeJavaScript(`globalThis.__start(${String(frameIntervalMs)})`)
    },
    async frame(png: Buffer): Promise<void> {
      if (web.isDestroyed()) return
      await web.executeJavaScript(`globalThis.__frame(${JSON.stringify(`data:image/png;base64,${png.toString('base64')}`)})`)
    },
    async stop(): Promise<AgentRecordingResult | undefined> {
      if (web.isDestroyed()) return undefined
      const result = await web.executeJavaScript('globalThis.__stop()') as AgentRecordingResult | null
      return result ?? undefined
    },
    dispose: (): Promise<void> => {
      if (!web.isDestroyed()) web.close()
      return Promise.resolve()
    },
  }
}

/**
 * Delete recordings past their time to live.
 * @param directory - directory holding finished recordings.
 * @param now - current time in milliseconds.
 * @returns The files that were removed.
 */
export async function pruneRecordings(directory: string, now: number): Promise<string[]> {
  const removed: string[] = []
  const names = await readdir(directory).catch(() => [] as string[])
  for (const name of names) {
    if (!name.endsWith('.webm')) continue
    const path = join(directory, name)
    const info = await stat(path).catch(() => undefined)
    if (info === undefined || now - info.mtimeMs <= AGENT_RECORDING_TTL_MS) continue
    await unlink(path).catch(() => undefined)
    removed.push(path)
  }
  return removed
}
