export type ServicePlatform = "darwin" | "linux-systemd" | null;
export declare const SERVICE_LABEL = "com.claude-max-api";
export declare const SERVICE_UNIT = "claude-max-api";
/**
 * Detect which service backend (if any) we can drive on the current host.
 * Returns null on unsupported platforms so callers can fall back to the
 * built-in daemonize() path.
 */
export declare function detectPlatform(): ServicePlatform;
export interface ServiceStatus {
    installed: boolean;
    running: boolean;
    /** Free-form human-readable detail line. */
    detail: string;
}
export declare function isInstalled(): boolean;
export declare function serviceStatus(): ServiceStatus;
/**
 * Write the service unit and register it with the platform's init system.
 * Idempotent: if already installed, the unit is overwritten and the service
 * restarted so upgrades pick up the new `node`/script paths.
 */
export declare function installService(port: number): void;
export declare function uninstallService(): void;
/**
 * Start the already-installed service. Caller should check isInstalled()
 * first; this function throws if invoked when the service isn't registered.
 */
export declare function startService(): void;
export declare function stopService(): void;
export declare function restartService(): void;
//# sourceMappingURL=service.d.ts.map