# Codex account login from the dashboard

## Goal

An authenticated dashboard administrator can add a Codex account, complete the official ChatGPT device-code sign-in, and see that account's quota without editing provider configuration or copying credentials. Existing file-configured Codex accounts and API-key providers keep working.

## User flow

The Add Account view offers Codex alongside the existing providers. Choosing Codex asks for a display name and starts a separate login flow. The page shows the verification URL and one-time code returned by Codex App Server, plus a waiting state. The administrator completes sign-in on the official site, and the page polls for completion. On success it refreshes the dashboard and shows the account's quota. On expiry, cancellation, or failure it shows a retry action. The page never accepts or displays an access token.

Device-code login must be enabled for the ChatGPT account or workspace. A disabled flow produces a clear error and points to the existing CLI login procedure as a fallback.

## Architecture

The `web` service owns admin authentication and CSRF checks. The `worker` service owns Codex CLI execution and the `runtime-auth` volume. A PostgreSQL login-request table bridges them. A POST endpoint creates one bounded pending request with a generated account ID; a GET endpoint returns only its public state. The worker claims requests, starts `codex app-server` with an isolated `CODEX_HOME`, calls `account/login/start` with `chatgptDeviceCode`, stores only the verification URL and user code in the request row, and holds the process until the `account/login/completed` notification. It then calls `account/read` and `account/rateLimits/read`, verifies ChatGPT mode, and persists the account and initial quota snapshot in one transaction.

The worker creates the Codex runtime directory with owner-only permissions. Login credentials remain in that directory. The DB stores neither access nor refresh tokens. The browser receives only the URL, one-time code, status, and a safe error code. URLs are accepted only when HTTPS and on an OpenAI-owned host; the UI opens them with `noopener noreferrer`.

Successful web-created accounts use a distinct managed runtime reference, so the worker refreshes them through `CodexQuotaStrategy` while the existing API-key credential path remains unchanged. File-configured accounts retain their current IDs and behavior. Repository reconciliation must preserve web-created accounts rather than disabling them as absent from the JSON file.

## State and failure handling

Request states are queued, starting, awaiting authorization, succeeded, failed, cancelled, and expired. Only one active login is allowed per administrator session; the server bounds the active count globally. Requests expire after a short fixed window. The worker treats process exit, malformed protocol messages, timeout, disabled device auth, and quota-read failure as explicit failures. It terminates the child on completion or cancellation. On worker restart, unfinished claims are marked retryable or expired; a new attempt gets a new isolated account ID. Failed attempts remove their unused runtime directory after the child exits. Existing successful accounts are never removed by retry cleanup.

The API requires the existing admin session for reads and writes and the existing CSRF token for start and cancel. Responses use `private, no-store`. A request can be polled only by the administrator session that created it. Polling does not expose login codes through the public display API. Rate limits, TTL, and input length bounds prevent unbounded process and DB growth.

## Verification

Tests cover API authorization and CSRF, request ownership, state transitions, worker protocol success and failure, credential isolation, account persistence, file-config reconciliation, and dashboard UI states. The worker tests use a fake App Server process; no real ChatGPT account is needed in CI. Typecheck and relevant unit/integration tests run before completion. A manual deployment check is required to prove the actual device-code flow and quota read against an opted-in ChatGPT account.
