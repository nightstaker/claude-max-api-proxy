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

const DEFAULT_PORT = 3456;
const SUBCOMMANDS = new Set([
    "start",
    "stop",
    "restart",
    "status",
    "logs",
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
  claude-max-api                  Run in the foreground (default port ${DEFAULT_PORT})
  claude-max-api <port>           Run in the foreground on the given port
  claude-max-api start [port]     Daemonize and return immediately
  claude-max-api stop             Stop the running daemon
  claude-max-api restart [port]   Stop then start in the background
  claude-max-api status           Show whether the daemon is running
  claude-max-api logs [-f]        Print (or follow) the daemon log file
  claude-max-api help             Show this help

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

async function cmdStart(port: number): Promise<void> {
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
        `Starting Claude Max API proxy in the background (initial pid ${childPid})...`,
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
    const result = await stopDaemon();
    if (result.pid === null) {
        console.log("No running server (no pidfile or stale pidfile).");
        return;
    }
    if (result.stopped) {
        console.log(`Stopped server (pid ${result.pid}).`);
    } else {
        console.error(`Failed to stop server (pid ${result.pid}).`);
        process.exit(1);
    }
}

function cmdStatus(): void {
    const info = getRunningDaemon();
    if (!info) {
        console.log("Not running.");
        // systemd-style "program not running" exit code, so shell scripts can
        // distinguish "not running" from a real error like "permission denied".
        process.exit(3);
    }
    console.log(
        `Running (pid ${info.pid}) on port ${info.port}, started ${info.startedAt}.`,
    );
    console.log(`Logs: ${LOG_FILE}`);
}

async function cmdRestart(port: number): Promise<void> {
    const result = await stopDaemon();
    if (result.stopped) {
        console.log(`Stopped previous server (pid ${result.pid}).`);
    }
    await cmdStart(port);
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
