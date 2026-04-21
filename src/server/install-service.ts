#!/usr/bin/env node
/**
 * Post-install hook + manual `install-service` entry point.
 *
 * Invocation patterns:
 *   node install-service.js --auto   # quiet postinstall from package.json
 *   node install-service.js          # interactive-style manual install
 *   node install-service.js <port>   # manual install on a specific port
 *
 * In --auto mode we bail out silently on any non-fatal condition (local
 * install, running as root, unsupported platform) so a failed postinstall
 * never blocks `npm install`. In manual mode we surface the real error.
 */
import { detectPlatform, installService, isInstalled } from "./service.js";

const DEFAULT_PORT = 3456;

function parsePort(arg: string | undefined): number {
    if (!arg) return DEFAULT_PORT;
    const n = parseInt(arg, 10);
    if (!Number.isFinite(n) || n < 1 || n > 65535) {
        throw new Error(`Invalid port: ${arg}`);
    }
    return n;
}

function main(): void {
    const auto = process.argv.includes("--auto");
    const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
    const port = parsePort(positional[0]);

    // Skip postinstall for local installs. Only register the service when
    // the user has actually done `npm install -g`. Otherwise every
    // `npm install` in the checkout (including CI) would mess with their
    // login services.
    if (auto && process.env.npm_config_global !== "true") {
        return;
    }

    // Refuse to install as root. `sudo npm install -g` is common on Linux,
    // but a user-level service installed by root would live under /root and
    // never auto-start for the actual user. Skip silently in --auto mode so
    // we don't explode the install, and print a friendly note.
    if ((process.getuid?.() ?? 0) === 0) {
        if (!auto) {
            console.error(
                "Refusing to install service as root. Re-run without sudo:\n" +
                    "  claude-max-api install-service",
            );
            process.exit(1);
        }
        const sudoUser = process.env.SUDO_USER;
        console.error(
            `[claude-max-api] Skipping auto service install (running as root${
                sudoUser ? `, invoked by ${sudoUser}` : ""
            }).`,
        );
        console.error(
            "[claude-max-api] To enable auto-start on login, run as your normal user:",
        );
        console.error("  claude-max-api install-service");
        return;
    }

    const platform = detectPlatform();
    if (!platform) {
        if (auto) return;
        console.error(
            `No supported service backend on ${process.platform}. Use 'claude-max-api start' for the built-in daemon fallback.`,
        );
        process.exit(1);
    }

    try {
        const wasInstalled = isInstalled();
        installService(port);
        if (auto) {
            console.log(
                `[claude-max-api] Service ${wasInstalled ? "updated" : "installed"} (${platform}) and set to auto-start on login.`,
            );
            console.log(
                `[claude-max-api] Manage with: claude-max-api {status,stop,restart,logs,uninstall-service}`,
            );
        } else {
            console.log(
                `Service ${wasInstalled ? "updated" : "installed"} on ${platform}, listening on port ${port}.`,
            );
            console.log("It will start automatically on login.");
        }
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (auto) {
            // Never fail the install. The user can re-run install-service
            // manually once they've fixed whatever went wrong.
            console.error(`[claude-max-api] Auto service install skipped: ${message}`);
            console.error("[claude-max-api] Re-run manually with: claude-max-api install-service");
            return;
        }
        console.error(`Failed to install service: ${message}`);
        process.exit(1);
    }
}

try {
    main();
} catch (err) {
    if (process.argv.includes("--auto")) {
        // Last-ditch guard: don't ever break npm install on our account.
        console.error(
            "[claude-max-api] Post-install hook failed:",
            err instanceof Error ? err.message : err,
        );
        process.exit(0);
    }
    throw err;
}
