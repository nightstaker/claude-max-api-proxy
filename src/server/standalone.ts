#!/usr/bin/env node
/**
 * Standalone server entry point for `claude-max-api`.
 *
 * Usage:
 *   claude-max-api                  Run in the foreground (default port 3456)
 *   claude-max-api 3457             Run in the foreground on port 3457
 *   claude-max-api start [port]     Daemonize and return immediately
 *   claude-max-api stop             Stop the running daemon
 *   claude-max-api restart [port]   Stop then start in the background
 *   claude-max-api status           Show whether the daemon is running
 *   claude-max-api logs [-f]        Print (or follow) the daemon log file
 *
 * The `start` family of commands uses ~/.claude-max-api/proxy.pid as a
 * pidfile and ~/.claude-max-api/proxy.log as the redirected log file.
 *
 * The hidden `--foreground` argument is what the parent passes to the
 * background child after spawning it; it makes the child write its own
 * pidfile once the listener is up.
 */
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { startServer, stopServer } from "./index.js";
import { verifyClaude, verifyAuth } from "../subprocess/manager.js";
import {
    LOG_FILE,
    PID_FILE,
    daemonize,
    getRunningDaemon,
    removePidFile,
    stopDaemon,
    waitForPidFile,
    writePidFile,
} from "./daemon.js";
import {
    detectPlatform,
    installService,
    isInstalled,
    restartService,
    serviceStatus,
    startService,
    stopService,
    uninstallService,
} from "./service.js";
import type { RequestEntryJSON } from "./request-tracker.js";

const DEFAULT_PORT = 3456;
const SUBCOMMANDS = new Set([
    "start",
    "stop",
    "restart",
    "status",
    "logs",
    "mon",
    "install-service",
    "uninstall-service",
    "help",
    "--help",
    "-h",
]);

function parsePort(arg: string | undefined): number {
    if (!arg) return DEFAULT_PORT;
    const port = parseInt(arg, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
        console.error(`Invalid port: ${arg}`);
        process.exit(1);
    }
    return port;
}

function printHelp(): void {
    console.log(`Usage:
  claude-max-api                         Run in the foreground (default port ${DEFAULT_PORT})
  claude-max-api <port>                  Run in the foreground on the given port
  claude-max-api install-service [port]  Register as a login service (launchd/systemd) and start it
  claude-max-api uninstall-service       Stop the service and remove its unit file
  claude-max-api start [port]            Start the service (falls back to built-in daemon if no service backend)
  claude-max-api stop                    Stop the service (or built-in daemon)
  claude-max-api restart [port]          Restart the service (or built-in daemon)
  claude-max-api status                  Show service + daemon status
  claude-max-api logs [-f]               Print (or follow) the log file
  claude-max-api mon [-n NUM]            Monitor recent requests (default 20, -1 = all)
  claude-max-api help                    Show this help

State files:
  pidfile: ${PID_FILE}
  log:     ${LOG_FILE}
`);
}

async function runForeground(port: number, registerPidFile: boolean): Promise<void> {
    console.log("Claude Code CLI Provider - Standalone Server");
    console.log("============================================\n");

    console.log("Checking Claude CLI...");
    const cliCheck = await verifyClaude();
    if (!cliCheck.ok) {
        console.error(`Error: ${cliCheck.error}`);
        process.exit(1);
    }
    console.log(`  Claude CLI: ${cliCheck.version || "OK"}`);

    console.log("Checking authentication...");
    const authCheck = await verifyAuth();
    if (!authCheck.ok) {
        console.error(`Error: ${authCheck.error}`);
        console.error("Please run: claude auth login");
        process.exit(1);
    }
    console.log("  Authentication: OK\n");

    try {
        await startServer({ port });
    } catch (err) {
        console.error("Failed to start server:", err);
        process.exit(1);
    }

    if (registerPidFile) {
        writePidFile({
            pid: process.pid,
            port,
            startedAt: new Date().toISOString(),
        });
        console.log(`[Daemon] Registered pidfile at ${PID_FILE}`);
    }

    console.log("\nServer ready. Test with:");
    console.log(`  curl -X POST http://localhost:${port}/v1/chat/completions \\`);
    console.log(`    -H "Content-Type: application/json" \\`);
    console.log(
        `    -d '{"model": "claude-sonnet-4", "messages": [{"role": "user", "content": "Hello!"}]}'`,
    );
    if (registerPidFile) {
        console.log("\nRunning in background. Send SIGTERM (or `claude-max-api stop`) to stop.\n");
    } else {
        console.log("\nPress Ctrl+C to stop.\n");
    }

    const shutdown = async () => {
        console.log("\nShutting down...");
        if (registerPidFile) removePidFile();
        await stopServer();
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

/**
 * Start the proxy.
 *
 * Preferred path: use the OS service (launchd / systemd user unit) that was
 * registered at install time. If the service isn't installed yet but the
 * platform supports one, auto-install it so the user never has to think about
 * it — this matches `npm install -g`'s postinstall behavior but also covers
 * the case where someone built from source.
 *
 * Fallback: if the platform has no service backend (rare: non-systemd Linux,
 * Windows, etc.) fall back to the self-daemonize path.
 */
async function cmdStart(port: number): Promise<void> {
    const platform = detectPlatform();
    if (!platform) {
        await cmdStartDaemon(port);
        return;
    }

    if (!isInstalled()) {
        console.log(`Installing service on ${platform}...`);
        try {
            installService(port);
        } catch (err) {
            console.error(`install-service failed: ${(err as Error).message}`);
            process.exit(1);
        }
        // RunAtLoad / enable --now already brought it up as part of install.
        const info = await waitForPidFile().catch(() => null);
        if (info) {
            console.log(`Service started (pid ${info.pid}) on port ${info.port}.`);
            console.log(`Logs: ${LOG_FILE}`);
        } else {
            console.log(`Service installed. Use 'claude-max-api status' to verify.`);
        }
        return;
    }

    try {
        startService();
    } catch (err) {
        console.error(`start failed: ${(err as Error).message}`);
        process.exit(1);
    }
    const info = await waitForPidFile(5000).catch(() => null);
    if (info) {
        console.log(`Service started (pid ${info.pid}) on port ${info.port}.`);
        console.log(`Logs: ${LOG_FILE}`);
    } else {
        console.log(`Service start requested. Use 'claude-max-api status' to verify.`);
    }
}

/**
 * Legacy self-daemonize path. Only invoked when the platform has no service
 * backend (detectPlatform() returned null).
 */
async function cmdStartDaemon(port: number): Promise<void> {
    const existing = getRunningDaemon();
    if (existing) {
        console.error(
            `Server is already running (pid ${existing.pid}, port ${existing.port}). Use 'stop' or 'restart' first.`,
        );
        process.exit(1);
    }

    const scriptPath = fileURLToPath(import.meta.url);
    const childPid = daemonize(scriptPath, [String(port)]);
    console.log(
        `No service backend on this platform — starting Claude Max API proxy in the background (initial pid ${childPid})...`,
    );
    try {
        const info = await waitForPidFile();
        console.log(`Server is running (pid ${info.pid}) on port ${info.port}.`);
        console.log(`Logs: ${LOG_FILE}`);
    } catch (err) {
        console.error(`Failed to confirm background startup: ${(err as Error).message}`);
        process.exit(1);
    }
}

async function cmdStop(): Promise<void> {
    const platform = detectPlatform();

    // Service path: ask launchd/systemd to stop the job. This SIGTERMs the
    // running child, which triggers its shutdown handler and removes the
    // pidfile on its own.
    if (platform && isInstalled()) {
        try {
            stopService();
        } catch (err) {
            console.error(`stop failed: ${(err as Error).message}`);
            process.exit(1);
        }
        // Wait briefly for the pidfile to disappear so status feels synchronous.
        const until = Date.now() + 5000;
        while (Date.now() < until && getRunningDaemon()) {
            await new Promise((r) => setTimeout(r, 100));
        }
        if (!getRunningDaemon()) {
            removePidFile();
            console.log("Service stopped.");
        } else {
            console.log("Stop requested. Verify with 'claude-max-api status'.");
        }
        return;
    }

    // Legacy/fallback path: SIGTERM the pidfile-tracked daemon directly.
    const result = await stopDaemon();
    if (result.pid === null) {
        console.log("No running server (no service installed and no pidfile).");
        return;
    }
    if (result.stopped) {
        console.log(`Stopped daemon (pid ${result.pid}).`);
    } else {
        console.error(`Failed to stop daemon (pid ${result.pid}).`);
        process.exit(1);
    }
}

function cmdStatus(): void {
    const info = getRunningDaemon();
    const svc = serviceStatus();

    if (svc.installed) {
        console.log(`Service: installed (${svc.detail})`);
    } else {
        const platform = detectPlatform();
        console.log(
            platform
                ? `Service: not installed (platform: ${platform})`
                : `Service: unsupported platform (${process.platform})`,
        );
    }

    if (info) {
        console.log(
            `Process: running (pid ${info.pid}) on port ${info.port}, started ${info.startedAt}.`,
        );
        console.log(`Logs: ${LOG_FILE}`);
        return;
    }

    console.log("Process: not running.");
    console.log(`Logs: ${LOG_FILE}`);
    // systemd-style "program not running" exit code.
    process.exit(3);
}

async function cmdRestart(port: number): Promise<void> {
    const platform = detectPlatform();

    if (platform && isInstalled()) {
        try {
            restartService();
        } catch (err) {
            console.error(`restart failed: ${(err as Error).message}`);
            process.exit(1);
        }
        const info = await waitForPidFile(5000).catch(() => null);
        if (info) {
            console.log(`Service restarted (pid ${info.pid}) on port ${info.port}.`);
        } else {
            console.log("Service restart requested. Verify with 'claude-max-api status'.");
        }
        return;
    }

    // Fallback: stop the daemon (if any) and re-spawn via the legacy path.
    const result = await stopDaemon();
    if (result.stopped) {
        console.log(`Stopped previous daemon (pid ${result.pid}).`);
    }
    await cmdStartDaemon(port);
    // Note on the port arg: changing port requires uninstall-service + reinstall
    // on the service path, since the plist/unit bakes in the original port.
    void port;
}

async function cmdInstallService(port: number): Promise<void> {
    const platform = detectPlatform();
    if (!platform) {
        console.error(
            `No service backend available on ${process.platform}. Use 'claude-max-api start' for the built-in daemon.`,
        );
        process.exit(1);
    }
    const wasInstalled = isInstalled();
    try {
        installService(port);
    } catch (err) {
        console.error(`install-service failed: ${(err as Error).message}`);
        process.exit(1);
    }
    console.log(
        `Service ${wasInstalled ? "updated" : "installed"} on ${platform}, listening on port ${port}.`,
    );
    console.log("It will start automatically on login.");
    console.log(`Logs: ${LOG_FILE}`);
}

function cmdUninstallService(): void {
    const platform = detectPlatform();
    if (!platform) {
        console.log(`No service backend on ${process.platform}; nothing to uninstall.`);
        return;
    }
    if (!isInstalled()) {
        console.log("Service is not installed.");
        return;
    }
    try {
        uninstallService();
    } catch (err) {
        console.error(`uninstall-service failed: ${(err as Error).message}`);
        process.exit(1);
    }
    console.log("Service stopped and unit file removed.");
}

function cmdLogs(follow: boolean): void {
    if (!fs.existsSync(LOG_FILE)) {
        console.log(`No logs yet at ${LOG_FILE}.`);
        return;
    }
    if (follow) {
        // Use tail -f rather than reimplementing it. tail is on every Unix
        // system the proxy is expected to run on (Linux + macOS).
        const tail = spawn("tail", ["-n", "200", "-f", LOG_FILE], {
            stdio: "inherit",
        });
        tail.on("exit", (code) => process.exit(code ?? 0));
        const forward = (sig: NodeJS.Signals) => {
            try {
                tail.kill(sig);
            } catch {
                /* ignore */
            }
        };
        process.on("SIGINT", () => forward("SIGINT"));
        process.on("SIGTERM", () => forward("SIGTERM"));
    } else {
        process.stdout.write(fs.readFileSync(LOG_FILE));
    }
}

// ── Monitor helpers ───────────────────────────────────────────────

interface MonitorResponse {
    requests: RequestEntryJSON[];
    active: number;
    maxConcurrent: number;
    timestamp: string;
}

function httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = "";
            res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
            res.on("end", () => resolve(data));
        }).on("error", reject);
    });
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(1)} MB`;
}

function formatElapsed(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    const rem = s - m * 60;
    return `${m}m${rem.toFixed(0)}s`;
}

function renderTable(data: MonitorResponse, port: number): string {
    const lines: string[] = [];
    lines.push(`Claude Max API \u2014 Request Monitor (port ${port})`);
    lines.push("\u2501".repeat(76));
    lines.push(
        ` ${"Request ID".padEnd(26)} ${"Input".padStart(9)} ${"Output".padStart(9)} ${"Status".padEnd(14)} ${"Elapsed".padStart(8)}`,
    );
    lines.push("\u2500".repeat(76));

    if (data.requests.length === 0) {
        lines.push("  (no requests yet)");
    } else {
        for (const r of data.requests) {
            const id = r.id.length > 24 ? r.id.slice(0, 22) + ".." : r.id.padEnd(24);
            const input = formatBytes(r.inputLength).padStart(9);
            const output = formatBytes(r.outputLength).padStart(9);
            const status = r.status.padEnd(14);
            const elapsed = formatElapsed(r.elapsedMs).padStart(8);
            lines.push(` ${id}  ${input} ${output}  ${status} ${elapsed}`);
        }
    }

    lines.push("\u2501".repeat(76));
    const ts = data.timestamp.replace("T", " ").replace(/\.\d+Z$/, "");
    lines.push(
        ` Active: ${data.active} / ${data.maxConcurrent}    Total: ${data.requests.length}    Updated: ${ts}`,
    );
    return lines.join("\n");
}

async function cmdMon(port: number, n: number): Promise<void> {
    const url = `http://127.0.0.1:${port}/v1/requests?n=${n}`;

    // Verify connectivity once before entering the loop.
    try {
        await httpGet(`http://127.0.0.1:${port}/health`);
    } catch {
        console.error(`Cannot reach server at http://127.0.0.1:${port}. Is it running?`);
        process.exit(1);
    }

    let running = true;
    const shutdown = () => {
        running = false;
        // Show cursor again and move below the table.
        process.stdout.write("\x1b[?25h");
        process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // Hide cursor for cleaner refreshes.
    process.stdout.write("\x1b[?25l");

    while (running) {
        try {
            const raw = await httpGet(url);
            const data: MonitorResponse = JSON.parse(raw);
            // Clear screen and move cursor to top-left.
            process.stdout.write("\x1b[2J\x1b[H");
            process.stdout.write(renderTable(data, port) + "\n");
        } catch {
            process.stdout.write("\x1b[2J\x1b[H");
            process.stdout.write(`Connection lost to http://127.0.0.1:${port} \u2014 retrying...\n`);
        }
        await new Promise((r) => setTimeout(r, 1000));
    }
}

async function main(): Promise<void> {
    const arg0 = process.argv[2];

    // Internal: invoked by daemonize() in the background child.
    if (arg0 === "--foreground") {
        const port = parsePort(process.argv[3]);
        await runForeground(port, true);
        return;
    }

    if (arg0 && SUBCOMMANDS.has(arg0)) {
        switch (arg0) {
            case "start":
                await cmdStart(parsePort(process.argv[3]));
                return;
            case "stop":
                await cmdStop();
                return;
            case "restart":
                await cmdRestart(parsePort(process.argv[3]));
                return;
            case "status":
                cmdStatus();
                return;
            case "logs": {
                const follow = process.argv[3] === "-f" || process.argv[3] === "--follow";
                cmdLogs(follow);
                return;
            }
            case "install-service":
                await cmdInstallService(parsePort(process.argv[3]));
                return;
            case "uninstall-service":
                cmdUninstallService();
                return;
            case "mon": {
                // Parse -n NUMBER from remaining args
                let monN = 20;
                const monArgs = process.argv.slice(3);
                for (let i = 0; i < monArgs.length; i++) {
                    if (monArgs[i] === "-n" && i + 1 < monArgs.length) {
                        monN = parseInt(monArgs[i + 1], 10);
                        if (isNaN(monN)) monN = 20;
                        break;
                    }
                }
                // Determine port from running daemon or fall back to default.
                const daemon = getRunningDaemon();
                const monPort = daemon?.port ?? DEFAULT_PORT;
                await cmdMon(monPort, monN);
                return;
            }
            case "help":
            case "--help":
            case "-h":
                printHelp();
                return;
        }
    }

    // Backwards compat: `claude-max-api [port]` runs in the foreground.
    const port = parsePort(arg0);
    await runForeground(port, false);
}

main().catch((err) => {
    console.error("Unexpected error:", err);
    process.exit(1);
});
