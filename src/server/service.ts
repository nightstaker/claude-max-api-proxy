/**
 * Platform-aware OS service manager.
 *
 * Registers the proxy as a user-level service that auto-starts on login and
 * exposes a cross-platform start/stop/restart/status API. The `standalone`
 * CLI dispatches to this module so `claude-max-api start` behaves the same
 * way whether we're on macOS (launchd) or Linux with systemd user units.
 *
 *   macOS          ~/Library/LaunchAgents/com.claude-max-api.plist  (launchctl)
 *   Linux/systemd  ~/.config/systemd/user/claude-max-api.service    (systemctl --user)
 *   anything else  null platform — callers fall back to the built-in daemonize()
 *
 * We intentionally stay in the user domain: no root, no LaunchDaemons, no
 * system-level systemd units. That matches the security posture of the
 * foreground binary (the proxy itself should never run as root).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { LOG_FILE } from "./daemon.js";

export type ServicePlatform = "darwin" | "linux-systemd" | null;

export const SERVICE_LABEL = "com.claude-max-api";
export const SERVICE_UNIT = "claude-max-api";

// ── Platform detection ────────────────────────────────────────────

/**
 * Detect which service backend (if any) we can drive on the current host.
 * Returns null on unsupported platforms so callers can fall back to the
 * built-in daemonize() path.
 */
export function detectPlatform(): ServicePlatform {
    if (process.platform === "darwin") return "darwin";
    if (process.platform === "linux") {
        const r = spawnSync("systemctl", ["--user", "--version"], {
            stdio: ["ignore", "ignore", "ignore"],
        });
        if (r.status === 0) return "linux-systemd";
    }
    return null;
}

// ── Paths ─────────────────────────────────────────────────────────

function plistPath(): string {
    return path.join(os.homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

function unitPath(): string {
    return path.join(os.homedir(), ".config", "systemd", "user", `${SERVICE_UNIT}.service`);
}

/**
 * Absolute path to the standalone.js that should be invoked by the service.
 * Resolves relative to *this* compiled module (dist/server/service.js), so
 * whichever directory npm/global-install unpacks us into is the one that
 * gets baked into the service definition.
 */
function resolveScriptPath(): string {
    const here = fileURLToPath(import.meta.url);
    return path.join(path.dirname(here), "standalone.js");
}

// ── Plist / unit templates ────────────────────────────────────────

interface UnitOptions {
    port: number;
    nodePath: string;
    scriptPath: string;
    home: string;
    path: string;
}

function plistBody(opts: UnitOptions): string {
    // KeepAlive.SuccessfulExit=false means launchd only restarts us on
    // abnormal exits (crash, OOM). A clean shutdown via `claude-max-api stop`
    // leaves the job unloaded, which is what the user wants.
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${SERVICE_LABEL}</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key><false/>
    </dict>
    <key>ProgramArguments</key>
    <array>
        <string>${opts.nodePath}</string>
        <string>${opts.scriptPath}</string>
        <string>--foreground</string>
        <string>${opts.port}</string>
    </array>
    <key>StandardOutPath</key><string>${LOG_FILE}</string>
    <key>StandardErrorPath</key><string>${LOG_FILE}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key><string>${opts.home}</string>
        <key>PATH</key><string>${opts.path}</string>
    </dict>
</dict>
</plist>
`;
}

function unitBody(opts: UnitOptions): string {
    // Restart=on-failure mirrors launchd's "restart on crash" posture:
    // a clean `systemctl --user stop` leaves the service stopped.
    return `[Unit]
Description=Claude Max API Proxy
After=network.target

[Service]
Type=simple
Environment=HOME=${opts.home}
Environment=PATH=${opts.path}
ExecStart=${opts.nodePath} ${opts.scriptPath} --foreground ${opts.port}
Restart=on-failure
RestartSec=5s
StandardOutput=append:${LOG_FILE}
StandardError=append:${LOG_FILE}

[Install]
WantedBy=default.target
`;
}

// ── Option resolution ─────────────────────────────────────────────

function buildOptions(port: number): UnitOptions {
    const home = os.homedir();
    // Seed PATH with common bin dirs so the service can find `claude`,
    // `oc-tool`, `ffmpeg`, etc. even when launched outside a login shell.
    const seeded = [
        path.join(home, ".npm-global", "bin"),
        path.join(home, ".nvm", "versions", "node"),
        path.join(home, ".local", "bin"),
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
    ];
    const inherited = (process.env.PATH ?? "").split(":").filter(Boolean);
    const merged = Array.from(new Set([...inherited, ...seeded])).join(":");
    return {
        port,
        nodePath: process.execPath,
        scriptPath: resolveScriptPath(),
        home,
        path: merged,
    };
}

// ── Helpers ───────────────────────────────────────────────────────

function run(
    cmd: string,
    args: string[],
): { ok: boolean; stdout: string; stderr: string; status: number | null } {
    const r = spawnSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    return {
        ok: r.status === 0,
        stdout: (r.stdout ?? "").toString(),
        stderr: (r.stderr ?? "").toString(),
        status: r.status,
    };
}

function uid(): number {
    return process.getuid?.() ?? 0;
}

function ensureDir(p: string): void {
    fs.mkdirSync(path.dirname(p), { recursive: true });
}

// ── Public API ────────────────────────────────────────────────────

export interface ServiceStatus {
    installed: boolean;
    running: boolean;
    /** Free-form human-readable detail line. */
    detail: string;
}

export function isInstalled(): boolean {
    const platform = detectPlatform();
    if (platform === "darwin") return fs.existsSync(plistPath());
    if (platform === "linux-systemd") return fs.existsSync(unitPath());
    return false;
}

export function serviceStatus(): ServiceStatus {
    const platform = detectPlatform();
    if (!platform) return { installed: false, running: false, detail: "platform unsupported" };

    if (platform === "darwin") {
        if (!fs.existsSync(plistPath())) {
            return { installed: false, running: false, detail: "not installed" };
        }
        const r = run("launchctl", ["print", `gui/${uid()}/${SERVICE_LABEL}`]);
        if (!r.ok) return { installed: true, running: false, detail: "loaded=no" };
        // `state = running` appears in the print output when the process is alive.
        const running = /state\s*=\s*running/.test(r.stdout);
        return {
            installed: true,
            running,
            detail: running ? "state=running" : "state=not running",
        };
    }

    // linux-systemd
    if (!fs.existsSync(unitPath())) {
        return { installed: false, running: false, detail: "not installed" };
    }
    const r = run("systemctl", ["--user", "is-active", SERVICE_UNIT]);
    const state = r.stdout.trim() || r.stderr.trim() || "unknown";
    return { installed: true, running: state === "active", detail: `state=${state}` };
}

/**
 * Write the service unit and register it with the platform's init system.
 * Idempotent: if already installed, the unit is overwritten and the service
 * restarted so upgrades pick up the new `node`/script paths.
 */
export function installService(port: number): void {
    const platform = detectPlatform();
    if (!platform) {
        throw new Error(
            `Unsupported platform: ${process.platform}. Use 'claude-max-api' directly or the built-in 'start' fallback.`,
        );
    }
    if (uid() === 0) {
        throw new Error(
            "Refusing to install service as root — run without sudo so the unit lives under your own user.",
        );
    }

    const opts = buildOptions(port);
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });

    if (platform === "darwin") {
        const target = plistPath();
        ensureDir(target);
        // If the unit is already loaded, bootout first so the new plist takes
        // effect on next bootstrap. Ignore failures — service may be absent.
        run("launchctl", ["bootout", `gui/${uid()}/${SERVICE_LABEL}`]);
        fs.writeFileSync(target, plistBody(opts));
        const r = run("launchctl", ["bootstrap", `gui/${uid()}`, target]);
        if (!r.ok) {
            throw new Error(
                `launchctl bootstrap failed (status ${r.status}): ${r.stderr.trim() || r.stdout.trim()}`,
            );
        }
        return;
    }

    // linux-systemd
    const target = unitPath();
    ensureDir(target);
    fs.writeFileSync(target, unitBody(opts));
    let r = run("systemctl", ["--user", "daemon-reload"]);
    if (!r.ok) throw new Error(`systemctl --user daemon-reload failed: ${r.stderr.trim()}`);
    r = run("systemctl", ["--user", "enable", "--now", SERVICE_UNIT]);
    if (!r.ok) {
        throw new Error(
            `systemctl --user enable --now failed (status ${r.status}): ${r.stderr.trim() || r.stdout.trim()}`,
        );
    }
}

export function uninstallService(): void {
    const platform = detectPlatform();
    if (!platform) return;

    if (platform === "darwin") {
        run("launchctl", ["bootout", `gui/${uid()}/${SERVICE_LABEL}`]);
        try {
            fs.unlinkSync(plistPath());
        } catch {
            /* already gone */
        }
        return;
    }

    run("systemctl", ["--user", "disable", "--now", SERVICE_UNIT]);
    try {
        fs.unlinkSync(unitPath());
    } catch {
        /* already gone */
    }
    run("systemctl", ["--user", "daemon-reload"]);
}

/**
 * Start the already-installed service. Caller should check isInstalled()
 * first; this function throws if invoked when the service isn't registered.
 */
export function startService(): void {
    const platform = detectPlatform();
    if (!platform) throw new Error("Service backend not available on this platform.");

    if (platform === "darwin") {
        if (!fs.existsSync(plistPath())) {
            throw new Error("Service is not installed. Run: claude-max-api install-service");
        }
        // bootstrap brings the service up and (because RunAtLoad=true) starts
        // it. If it's already loaded, bootstrap exits non-zero — fall back to
        // kickstart in that case.
        let r = run("launchctl", ["bootstrap", `gui/${uid()}`, plistPath()]);
        if (!r.ok) {
            r = run("launchctl", ["kickstart", `gui/${uid()}/${SERVICE_LABEL}`]);
            if (!r.ok) {
                throw new Error(`launchctl start failed: ${r.stderr.trim() || r.stdout.trim()}`);
            }
        }
        return;
    }

    if (!fs.existsSync(unitPath())) {
        throw new Error("Service is not installed. Run: claude-max-api install-service");
    }
    const r = run("systemctl", ["--user", "start", SERVICE_UNIT]);
    if (!r.ok) throw new Error(`systemctl --user start failed: ${r.stderr.trim()}`);
}

export function stopService(): void {
    const platform = detectPlatform();
    if (!platform) throw new Error("Service backend not available on this platform.");

    if (platform === "darwin") {
        // bootout unloads the job and SIGTERMs the process. On a fresh install
        // where the job was never loaded, this exits non-zero — treat that as
        // a no-op.
        run("launchctl", ["bootout", `gui/${uid()}/${SERVICE_LABEL}`]);
        return;
    }

    const r = run("systemctl", ["--user", "stop", SERVICE_UNIT]);
    if (!r.ok) throw new Error(`systemctl --user stop failed: ${r.stderr.trim()}`);
}

export function restartService(): void {
    const platform = detectPlatform();
    if (!platform) throw new Error("Service backend not available on this platform.");

    if (platform === "darwin") {
        if (!fs.existsSync(plistPath())) {
            throw new Error("Service is not installed. Run: claude-max-api install-service");
        }
        // -k SIGTERMs the current instance and KeepAlive brings it back up.
        // If the service wasn't running, kickstart alone starts it.
        let r = run("launchctl", ["kickstart", "-k", `gui/${uid()}/${SERVICE_LABEL}`]);
        if (!r.ok) {
            // May not be loaded yet — bootstrap brings it up fresh.
            r = run("launchctl", ["bootstrap", `gui/${uid()}`, plistPath()]);
            if (!r.ok) throw new Error(`launchctl restart failed: ${r.stderr.trim()}`);
        }
        return;
    }

    const r = run("systemctl", ["--user", "restart", SERVICE_UNIT]);
    if (!r.ok) throw new Error(`systemctl --user restart failed: ${r.stderr.trim()}`);
}
