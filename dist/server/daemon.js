/**
 * Background daemon utilities for the standalone server.
 *
 * The proxy is a long-lived process that ought to keep running across
 * terminal sessions, but it does not need a system-level service manager
 * (systemd / launchd) for the common case. This module gives `claude-max-api`
 * a built-in `start` / `stop` / `status` lifecycle by re-spawning itself
 * as a detached child and tracking it with a small pidfile.
 *
 * State files live under ~/.claude-max-api/:
 *   proxy.pid   — JSON: { pid, port, startedAt }
 *   proxy.log   — combined stdout+stderr from the background process
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
const STATE_DIR = path.join(os.homedir(), ".claude-max-api");
export const PID_FILE = path.join(STATE_DIR, "proxy.pid");
export const LOG_FILE = path.join(STATE_DIR, "proxy.log");
function ensureStateDir() {
    fs.mkdirSync(STATE_DIR, { recursive: true });
}
export function readPidFile() {
    try {
        const raw = fs.readFileSync(PID_FILE, "utf8");
        const parsed = JSON.parse(raw);
        if (typeof parsed?.pid === "number" &&
            typeof parsed?.port === "number" &&
            typeof parsed?.startedAt === "string") {
            return parsed;
        }
        return null;
    }
    catch {
        return null;
    }
}
export function writePidFile(info) {
    ensureStateDir();
    fs.writeFileSync(PID_FILE, JSON.stringify(info, null, 2));
}
export function removePidFile() {
    try {
        fs.unlinkSync(PID_FILE);
    }
    catch {
        /* ignore — file may have already been removed */
    }
}
/**
 * Best-effort liveness check. process.kill(pid, 0) does not deliver a signal,
 * it just performs the permission/existence check the kernel does normally.
 */
export function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Return the live daemon described by the pidfile, or null if there is no
 * daemon (or the pidfile is stale, in which case we also clean it up).
 */
export function getRunningDaemon() {
    const info = readPidFile();
    if (!info)
        return null;
    if (!isAlive(info.pid)) {
        removePidFile();
        return null;
    }
    return info;
}
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
export function daemonize(scriptPath, args) {
    ensureStateDir();
    const logFd = fs.openSync(LOG_FILE, "a");
    try {
        const child = spawn(process.execPath, [scriptPath, "--foreground", ...args], {
            detached: true,
            stdio: ["ignore", logFd, logFd],
            env: process.env,
        });
        child.unref();
        return child.pid ?? -1;
    }
    finally {
        fs.closeSync(logFd);
    }
}
/**
 * Wait for the background child to register itself in the pidfile.
 * Resolves with the daemon info, or rejects after `timeoutMs` if the
 * child failed to come up (the user should then read LOG_FILE).
 */
export async function waitForPidFile(timeoutMs = 8_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const info = readPidFile();
        if (info && isAlive(info.pid))
            return info;
        await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Background process did not register within ${timeoutMs}ms. Check ${LOG_FILE} for startup errors.`);
}
/**
 * SIGTERM the running daemon and wait for it to exit, escalating to SIGKILL
 * if it does not stop within `timeoutMs`. Cleans up the pidfile in either
 * case.
 *
 * Returns:
 *   { stopped: true,  pid }  — daemon was running and is now stopped
 *   { stopped: false, pid: null } — no daemon was running
 */
export async function stopDaemon(timeoutMs = 10_000) {
    const info = getRunningDaemon();
    if (!info)
        return { stopped: false, pid: null };
    try {
        process.kill(info.pid, "SIGTERM");
    }
    catch {
        // Process is already gone — clean up and report success.
        removePidFile();
        return { stopped: true, pid: info.pid };
    }
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (!isAlive(info.pid)) {
            removePidFile();
            return { stopped: true, pid: info.pid };
        }
        await new Promise((r) => setTimeout(r, 100));
    }
    // Did not exit within timeout — escalate.
    try {
        process.kill(info.pid, "SIGKILL");
    }
    catch {
        /* ignore */
    }
    removePidFile();
    return { stopped: true, pid: info.pid };
}
//# sourceMappingURL=daemon.js.map