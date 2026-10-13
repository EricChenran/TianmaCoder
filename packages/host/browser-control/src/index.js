/**
 * Wire contract shared by the Host browser control seam and the Electron shell:
 * request, result, and event shapes plus the narrow guards both sides compile against.
 * @module @deepseek-ai/dsh-host-browser-control
 */
/** Narrow a Host IPC message to the browser control seam. */
export function isBrowserControlRequest(message) {
    if (typeof message !== 'object' || message === null)
        return false;
    const candidate = message;
    if (candidate.type !== 'browser' || !Number.isSafeInteger(candidate.requestId))
        return false;
    switch (candidate.op) {
        case 'acquire':
            return typeof candidate.workspaceKey === 'string' && candidate.workspaceKey.length > 0;
        case 'execute':
            return typeof candidate.leaseId === 'string' && candidate.leaseId.length > 0
                && typeof candidate.command === 'string' && candidate.command.length > 0;
        case 'release':
            return typeof candidate.leaseId === 'string' && candidate.leaseId.length > 0;
        default:
            return false;
    }
}
/** Narrow a Host IPC message to a shell-originated answer or event on this seam. */
export function isBrowserControlMessage(message) {
    if (typeof message !== 'object' || message === null)
        return false;
    const candidate = message;
    if (candidate.type === 'browser-result') {
        if (!Number.isSafeInteger(candidate.requestId) || typeof candidate.ok !== 'boolean')
            return false;
        if (candidate.ok)
            return true;
        return typeof candidate.error === 'string' && (candidate.code === undefined || typeof candidate.code === 'string');
    }
    if (candidate.type === 'browser-event') {
        return typeof candidate.name === 'string' && candidate.name.length > 0
            && (candidate.leaseId === undefined || typeof candidate.leaseId === 'string');
    }
    return false;
}
/** Default deadline for one browser control round trip. */
export const BROWSER_CONTROL_TIMEOUT_MS = 10_000;
/** Failure reported by the shell with a stable code the caller can branch on. */
export class BrowserControlError extends Error {
    /** Stable failure family from the shell; `undefined` when the shell did not classify the failure. */
    code;
    /**
     * @param message - Shell-provided failure description.
     * @param code - Stable failure family, when the shell classified the failure.
     */
    constructor(message, code) {
        super(message);
        this.code = code;
    }
}
//# sourceMappingURL=index.js.map