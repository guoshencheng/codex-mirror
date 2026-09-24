# Self-Hosted Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate the read-only display from the Next.js management service and deploy the application stack to `180.184.45.232` without disturbing existing sites.

**Architecture:** Keep the Next.js app as the API and management UI, add a separately built static display that reads a Bearer-protected snapshot, and run both with PostgreSQL and Provider Runtime on the target server. Keep collector credentials unchanged. The user will create the public 1Panel site and certificate afterward.

**Tech Stack:** Next.js 16, React 19, TypeScript, PostgreSQL, Docker Compose, static HTML/CSS/JavaScript.

**Spec:** `docs/superpowers/specs/2026-09-23-self-hosted-display-design.md`

## Global Constraints

- Preserve all current uncommitted user changes in this working tree.
- Do not modify existing 1Panel sites or occupy ports 80, 443, or 3000.
- Do not print or commit generated secrets.
- Preserve per-device Token hashes, device IDs, and collector migration behavior.
- The public domain is `codex-status.icerock.top`; final HTTPS verification follows the user's site and certificate setup.

## Review Focus

- Missing or malformed server Token configuration must fail closed without logging the Token.
- Wrong Bearer Token must receive 401; an untrusted browser origin must not receive CORS permission.
- Rotating the user Token must invalidate the existing admin session without affecting collector Token verification.
- The static display must not silently present stale data as current after a network failure.
- Deploying the new stack must leave the existing OpenResty and port-3000 Next.js project running.

---

### Task 1: Server-configured user Token and admin session

**Files:** `src/server/auth/*`, `src/app/api/auth/*`, `scripts/*`, `tests/unit/*`, `tests/integration/*`, deployment docs.

**Interfaces:** Server reads one private Token file at runtime; admin login accepts that Token, signs a short-lived HttpOnly session, and preserves CSRF checks for cookie-authenticated writes.

- [ ] Write failing tests for configured Token login, invalid Token, session verification, rotation invalidation, and CSRF.
- [ ] Run focused tests and confirm they fail for the missing behavior.
- [ ] Implement configuration loading, stateless session signing, login/logout/session routes, and any affected registration route.
- [ ] Run focused tests and the complete test suite; repair only regressions attributable to this task.
- [ ] Update setup documentation and the private-config example without including a real Token.

### Task 2: Display snapshot API and independent static client

**Files:** `src/app/api/display/*`, `src/server/read-model/*`, `display/*`, `package.json`, `tests/unit/*`, `tests/e2e/*`.

**Interfaces:** `GET /api/display/dashboard` accepts the configured user Token as Bearer auth and returns a no-store JSON snapshot. The independent client stores its API URL at runtime, polls this endpoint, and marks stale data.

- [ ] Write failing API tests for correct/missing/wrong Token, no-store response, and CORS allowlist.
- [ ] Run focused tests and confirm the expected failures.
- [ ] Implement the API and a separate static display build that consumes the existing dashboard contract.
- [ ] Write and run browser tests covering API URL entry, successful rendering, failed fetch, and retained stale snapshot.
- [ ] Run static build, Next build, typecheck, and the complete test suite.

### Task 3: Provider refresh independent of browser visibility

**Files:** `src/worker/main.ts`, `src/server/quota/*`, `src/components/use-dashboard-polling.ts`, `tests/unit/*`, `tests/integration/*`.

**Interfaces:** Provider Runtime processes due configured and DB-managed accounts. Display and management views read results; their visibility does not schedule refresh.

- [ ] Write a failing worker test showing a due DB-managed account is refreshed without a browser request.
- [ ] Run the test and confirm the expected failure.
- [ ] Add managed account selection and secret access to the worker; remove browser-dependent periodic refresh.
- [ ] Run worker tests, full tests, typecheck, and build.

### Task 4: Single-server deployment artifacts

**Files:** `deploy/compose.self-hosted.yaml`, `deploy/Dockerfile.web`, `deploy/Dockerfile.display`, `deploy/*` runtime config examples, `docs/deployment.md`.

**Interfaces:** Compose exposes Web/API and static display only on `127.0.0.1` on unused ports; PostgreSQL is internal; Provider Runtime shares the private database network and auth volume.

- [ ] Add static checks for Compose ports, secret mounts, and health checks.
- [ ] Verify the checks fail before adding the deployment files.
- [ ] Add Dockerfiles, Compose file, secret-generation instructions, migration/runbook, and a 1Panel reverse-proxy handoff.
- [ ] Validate Compose configuration and build images locally when Docker is available; otherwise build on the target host.

### Task 5: Deploy and verify on target server

**Files:** deployment directory on `180.184.45.232`; no existing site files.

- [ ] Recheck target free ports, disk, running containers, and existing services.
- [ ] Copy the exact tested release into a new restricted directory and generate server-only secrets there.
- [ ] Start PostgreSQL, run migrations, then start Web/API, static display, and Provider Runtime.
- [ ] Verify loopback health, 401 responses, authenticated snapshot, static display, and unchanged existing processes.
- [ ] Report the internal endpoint ports and exact 1Panel routing/HTTPS steps for the user; run public HTTPS checks only after the user adds the site and certificate.
