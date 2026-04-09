export declare const PID_FILE: string;
export declare const LOG_FILE: string;
export interface DaemonInfo {
    pid: number;
    port: number;
    startedAt: string;
}
export declare function readPidFile(): DaemonInfo | null;
export declare function writePidFile(info: DaemonInfo): void;
export declare function removePidFile(): void;
/**
 * Best-effort liveness check. process.kill(pid, 0) does not deliver a signal,
 * it just performs the permission/existence check the kernel does normally.
 */
export declare function isAlive(pid: number): boolean;
/**
 * Return the live daemon described by the pidfile, or null if there is no
 * daemon (or the pidfile is stale, in which case we also clean it up).
 */
export declare function getRunningDaemon(): DaemonInfo | null;
/**
 * Re-spawn the standalone entry point as a detached background process.
 *
 * The current Node binary and the script path of the running CLI are reused
 * verbatim so that whichever way the user invoked us (npm link, global
 * install, npx, …) keeps working without us having to guess.
 *
 * The child is started with `--foreground` so it knows NOT to recurse and
 * to write its own pidfile after the HTTP listener is up. stdout and stderr
 * are redirected to LOG_FILE in append mode.
 */
export declare function daemonize(scriptPath: string, args: string[]): number;
/**
 * Wait for the background child to register itself in the pidfile.
 * Resolves with the daemon info, or rejects after `timeoutMs` if the
 * child failed to come up (the user should then read LOG_FILE).
 */
export declare function waitForPidFile(timeoutMs?: number): Promise<DaemonInfo>;
/**
 * SIGTERM the running daemon and wait for it to exit, escalating to SIGKILL
 * if it does not stop within `timeoutMs`. Cleans up the pidfile in either
 * case.
 *
 * Returns:
 *   { stopped: true,  pid }  — daemon was running and is now stopped
 *   { stopped: false, pid: null } — no daemon was running
 */
export declare function stopDaemon(timeoutMs?: number): Promise<{
    stopped: boolean;
    pid: number | null;
}>;
//# sourceMappingURL=daemon.d.ts.map