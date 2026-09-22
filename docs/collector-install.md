# Codex device collector

The collector runs on each device that uses Codex. Codex lifecycle Hooks append a small, allowlisted event to a local SQLite queue. A separate foreground daemon sends those events and a 20-second collector heartbeat to the dashboard over HTTPS. It never inspects Codex processes, session files, transcripts, prompts, or tool arguments.

## Configure a device

Create the device in the dashboard first and copy its one-time device token. Save a config file at `~/.config/codex-status-dashboard/config.json` with mode `0600`:

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

The SQLite queue uses WAL and full synchronous writes. Events remain on disk until the server commits and acknowledges a contiguous sequence. Network errors and 401/403 responses never clear queued events. The collector sends a startup recovery heartbeat containing its persisted epoch, boot ID, queue depth, and highest queued sequence before it uploads backlog; this lets the server keep recovered old work unconfirmed until a new Hook event arrives. It retries with jittered backoff, and caps batches at 100 events / 256 KB.

Only session/turn/tool lifecycle types, session and turn IDs, event time, a safe tool name, and a normalized project key/name are retained. Repository credentials and URL parameters are removed; paths are used locally to calculate a hash and are never uploaded. Queue exhaustion leaves pending events intact and marks event loss for the dashboard.

Hook observations are not a complete process monitor. `SessionEnd` runs synchronously and can arrive only after the session closes or has been idle for a while; permission-request hooks report that approval is about to be requested, not its final decision. A stale heartbeat or a long-silent active turn therefore lowers confidence instead of inventing a completion result. Existing sessions do not receive retrospective events until another Hook fires.
