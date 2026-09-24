# Codex device collector

The collector runs on each device that uses Codex. Codex lifecycle Hooks append a small, allowlisted event to a local SQLite queue. A separate foreground daemon sends those events and a 20-second collector heartbeat to the dashboard over HTTPS. It does not inspect Codex processes, session files, transcripts, prompts, or tool arguments. The daemon uses the local Codex App Server to read names for sessions already seen through Hooks.

## One-command installation (macOS / Linux)

Install Node.js 24 or newer (including npm). In the signed-in Dashboard, open **设备**, click **生成一次性安装命令**, then run the displayed command in the target device's terminal. It has this form:

```sh
curl -fsSL '<one-time install URL from the Dashboard>' | bash
```

No manual device creation is required. The generated URL contains a random, one-use enrollment grant that expires after 15 minutes and can register one device. The cloud returns a customized shell script containing only that scoped grant; the Dashboard user Token is never placed in the URL or script. The installer registers this machine using its hostname, receives a device ID and device Token, and writes them to the private local config. Registration retries use a private local idempotency key so a lost response does not create an orphan device. Subsequent installs reuse the existing device config.

The public generic installer remains available at `https://codex-status-dashboard.vercel.app/install.sh`; when run directly, it hides the Dashboard user Token prompt and performs the same registration. Prefer the generated one-time link when setting up a device without interactive credential entry.

The installer downloads and verifies the collector package, installs dependencies in `~/.local/share/codex-status-dashboard/releases/`, creates a mode-0600 configuration, preserves unrelated Hooks, sends an authenticated heartbeat, and starts a LaunchAgent on macOS or a systemd user service on Linux. It never requires the project checkout on the device. Node native dependencies may need a compiler if no prebuilt binary is available for the installed Node version; Node.js 24 LTS is recommended.

## Moving the server

Keep the collector URL stable if possible: move DNS to the new deployment and restore the same database, including the `devices` records. Devices then continue reporting without local changes.

When the URL changes, deploy the new server and its `/api/agent/identity` endpoint first, with the existing device database. Run a fresh installation command from the new Dashboard on each device. The installer inspects the private device config, managed Hooks, collector script, and user service. It authenticates the existing device token against the new server and verifies that the returned device ID matches the local ID before changing any local configuration. A successful migration keeps the device token and SQLite queue, backs up the old config, changes only `serverUrl`, repairs Hooks, and restarts the service. Changed Hooks may need review in Codex `/hooks`.

If the new server does not recognize the device, use a fresh one-time installation command from the new Dashboard. Its scoped grant authorizes the new server to adopt the existing device ID and token hash; the installer then verifies the identity endpoint, sends a heartbeat, and changes only the local server URL. The local SQLite queue remains bound to the same device. The first heartbeat tells the new server where the old queue's pending sequence begins, so previously acknowledged events do not block replay. An expired grant, an existing conflicting device identity, a reachable server returning another device ID, or network/server errors stop the migration without changing local config or queue. A partial local install with managed Hooks, a service, or a queue but no device config is left intact for inspection.

The one-time Dashboard command supplies its own server URL. The server can set `COLLECTOR_PUBLIC_ORIGIN` to a stable collector-facing HTTPS domain when that differs from the Dashboard login origin; newly generated links then use that domain. For a generic installer hosted at a custom URL, explicitly pass the target URL to the shell running it, for example: `curl -fsSL https://new.example/install.sh | COLLECTOR_SERVER_URL=https://new.example bash`. Simply downloading `install.sh` from a different host does not set that environment variable.

Open Codex and review/trust the new Hooks in `/hooks`. This trust step is not bypassed by the installer. Existing sessions are not backfilled.

Rerun the generated command within its 15-minute validity window for the initial setup. Existing device configuration and the SQLite queue are preserved; old release directories are kept for recovery. Linux needs a running systemd user session; `loginctl enable-linger "$USER"` is needed if it must run after logout. To install without registering a service, append `-s -- --no-service` to the generated command's `bash` invocation, or use the generic installer with its hidden Token prompt.

If registration succeeds but the first heartbeat fails before `config.json` is written, rerun an install command. The private `.registration-id` file lets the server return the same device credentials, and the existing SQLite queue must match that device ID. A fresh one-time link works if the first link has expired; do not delete the queue or registration key. Other partial installations without a matching retry key remain blocked for inspection.

The installation heartbeat allows 15 seconds per attempt and retries temporary network errors and server 5xx responses twice. Authentication failures stop immediately. A failed installation reports the stage and a bounded error code without printing the device Token.

For networks requiring an HTTP proxy, export `HTTPS_PROXY` before running the command. The installer enables Node proxy support and saves these proxy settings into the background service.

Service status: `launchctl print gui/$(id -u)/com.codex-status-dashboard.collector` on macOS, or `systemctl --user status codex-status-dashboard` on Linux. macOS logs: `~/.config/codex-status-dashboard/collector.log`.

## Manual configuration

Create the device using the administration CLI first and copy its one-time device token. Save a config file at `~/.config/codex-status-dashboard/config.json` with mode `0600`:

```json
{
  "schemaVersion": 1,
  "deviceId": "device-id-from-dashboard",
  "deviceToken": "one-time-token-from-dashboard",
  "serverUrl": "https://dashboard.example.com",
  "queuePath": "./events.sqlite"
}
```

The queue path is relative to the config file. Keep the token out of shell history, Git, and shared folders. The collector rejects config files accessible to group or other users, rejects symbolic links, and requires HTTPS except for loopback development servers.

## Build and review Codex Hooks

Use Node.js 24 or newer, install project dependencies, and build the collector:

```sh
npm ci
npm run collector:build
node dist/collector/cli.js install --dry-run
node dist/collector/cli.js install
```

The dry run prints the merged `~/.codex/hooks.json` without writing it. Installation backs up an existing file and atomically merges eight lifecycle hooks while preserving unrelated settings and handlers. It does not edit `config.toml`; if that file already defines inline hooks, Codex merges both sources and may warn. The installer uses synchronous local handlers with a three-second timeout so event sequence is assigned in invocation order; uploads never run in a Hook.

After installation, open Codex and use `/hooks` to review and trust these non-managed hooks. Codex skips new or changed hook definitions until they are trusted. `node dist/collector/cli.js uninstall` removes only handlers carrying this collector's marker and leaves other Hook handlers in place. It keeps the local queue so it can still be inspected or backed up.

The `Stop` hook always returns the non-blocking JSON `{"continue":true}`. Other hooks produce no stdout. Failures write only a fixed diagnostic to stderr and return success to Codex; the local queue health marker will be included in the next heartbeat when possible.

## Keep the daemon running

Run it in the foreground to verify connectivity:

```sh
node dist/collector/cli.js run
```

For a Linux user service, save the following as `~/.config/systemd/user/codex-status-dashboard.service`, replacing the executable and repository paths:

```ini
[Unit]
Description=Codex Status Dashboard event collector
After=network-online.target

[Service]
ExecStart=/usr/bin/node /opt/codex-status-dashboard/dist/collector/cli.js run
Restart=on-failure
RestartSec=5
Environment=COLLECTOR_CONFIG=%h/.config/codex-status-dashboard/config.json

[Install]
WantedBy=default.target
```

Then run `systemctl --user daemon-reload`, `systemctl --user enable --now codex-status-dashboard`, and `loginctl enable-linger "$USER"` if the collector must run without an interactive login.

On macOS, install a LaunchAgent with `ProgramArguments` containing the absolute Node executable, the absolute `dist/collector/cli.js` path, and `run`; set `RunAtLoad` and `KeepAlive` to true. Store the plist in `~/Library/LaunchAgents` and load it with `launchctl`. Do not put the device token in the plist; the service reads the mode-0600 config file.

## Queue and event semantics

The SQLite queue uses WAL and full synchronous writes. Events remain on disk until the server commits and acknowledges a contiguous sequence. Network errors and 401/403 responses never clear queued events. The collector sends a startup recovery heartbeat containing its persisted epoch, boot ID, queue depth, first pending sequence, and highest queued sequence before it uploads backlog; this lets a new server continue a migrated queue and keep recovered old work unconfirmed until a new Hook event arrives. It retries with jittered backoff, and caps batches at 100 events / 256 KB.

The collector uploads session/turn lifecycle events and `PreToolUse` / `PostToolUse` events with session and turn IDs, event time, and tool name when present. Existing project identity is attached where available. It never uploads tool arguments, command text, file contents, tool output, or conversation text. Events are written to a local SQLite queue and stored in `agent_events`; applied history older than 30 days is cleaned up, while active-turn start events and event-gap evidence are preserved. The reduced current state, including `currentTool`, remains separately available in `sessions`. Repository credentials and URL parameters are removed; local paths are used only to calculate a project hash and are never uploaded. Queue exhaustion leaves pending events intact and marks event loss for the dashboard.

The dashboard shows the active tool and relative time since the last event in session details. The active tool clears when its matching `PostToolUse` arrives. Hook events refresh activity only when a tool starts or finishes; long thinking periods and tools that run for more than ten minutes can still become unconfirmed. Existing sessions do not receive retrospective events until another Hook fires. Re-run the device installer to add or restore the managed `PreToolUse` hook, then review and trust changed hooks in Codex `/hooks`.

The daemon checks names only for sessions observed through Hooks. It batches up to ten `thread/read` summary requests in one short-lived local App Server connection per pass, without loading turns. Missing names are retried after 20 seconds for the first five minutes, then every five minutes; named sessions are rechecked after five minutes for renames while their last Hook is less than 24 hours old. Title changes use `session.metadata.updated`, which does not alter execution state or its activity timestamp. One-command setup records the `codex` executable found on the installer's `PATH` in the background service environment. For a manually installed service, set `CODEX_COMMAND` to the absolute `codex` executable path if it is not on the service's `PATH`; otherwise, session short IDs remain visible.

Hook observations are not a complete process monitor. `SessionEnd` runs synchronously and can arrive only after the session closes or has been idle for a while; permission-request hooks report that approval is about to be requested, not its final decision. A stale heartbeat or a long-silent active turn therefore lowers confidence instead of inventing a completion result. Existing sessions do not receive retrospective events until another Hook fires.
