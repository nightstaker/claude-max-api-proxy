# macOS Auto-Start Setup

As of v1.4, auto-start is handled by `claude-max-api install-service`, which
is invoked automatically by the global npm install.

## Install

```bash
npm install -g claude-max-api-proxy
```

The post-install hook writes `~/Library/LaunchAgents/com.claude-max-api.plist`
and loads it into your user's `gui/<uid>` launchd domain. `RunAtLoad` + a
conditional `KeepAlive` (`SuccessfulExit=false`) means it starts on login and
restarts on crash, but stays down after a deliberate `claude-max-api stop`.

## Manage

```bash
claude-max-api status              # loaded + running?
claude-max-api stop                # launchctl bootout
claude-max-api start               # launchctl bootstrap (or kickstart)
claude-max-api restart             # launchctl kickstart -k
claude-max-api logs -f             # tail the service log
```

Logs go to `~/.claude-max-api/proxy.log` (stdout + stderr merged).

## Change the port

```bash
claude-max-api install-service 3457
```

That rewrites the plist with the new port and reloads the service. No manual
plist editing needed.

## Uninstall

```bash
claude-max-api uninstall-service
# or, to remove the whole package:
npm uninstall -g claude-max-api-proxy
```

> `npm uninstall -g` does **not** reliably run pre-uninstall hooks, so run
> `uninstall-service` first if you want to be sure the LaunchAgent is gone
> before the binary disappears.

## Troubleshooting

Tail the log and check service state:

```bash
claude-max-api logs -f
claude-max-api status
launchctl print "gui/$(id -u)/com.claude-max-api"
```

Common issues:
- **`claude: command not found` in logs** — the service inherits a minimal
  PATH. `install-service` seeds common locations (`/opt/homebrew/bin`,
  `/usr/local/bin`, `~/.npm-global/bin`, `~/.nvm/...`), but if yours is
  somewhere else, re-run `install-service` with the desired `PATH` exported
  in your current shell — it's captured at install time.
- **Not starting on login over SSH** — LaunchAgents in the `gui/<uid>`
  domain require a GUI session. SSH-only Macs should use a plain
  `claude-max-api start` in a tmux/`at`-scheduled login shell instead.
