#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
: "${DATABASE_DIRECT_URL:?Set DATABASE_DIRECT_URL in the protected shell environment}"
: "${BACKUP_DIR:?Set BACKUP_DIR to an encrypted or access-restricted directory outside this checkout}"

for command in docker pg_dump psql tar; do
  command -v "$command" >/dev/null 2>&1 || { printf 'Required command missing: %s\n' "$command" >&2; exit 1; }
done
[[ -f "$repo_root/.env" ]] || { printf 'Missing protected %s/.env for Compose version pins.\n' "$repo_root" >&2; exit 1; }
[[ -f "$repo_root/deploy/provider-accounts.json" ]] || { printf 'Missing deploy/provider-accounts.json.\n' >&2; exit 1; }
[[ ! -L "$repo_root/deploy/provider-accounts.json" ]] || { printf 'Provider account config must not be a symbolic link.\n' >&2; exit 1; }
[[ -d "$repo_root/deploy/secrets" ]] || { printf 'Missing deploy/secrets directory.\n' >&2; exit 1; }
secret_symlink="$(find "$repo_root/deploy/secrets" -type l -print -quit)"
if [[ -n "$secret_symlink" ]]; then
  printf 'Secret directory must not contain symbolic links.\n' >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
backup_root="$(cd "$BACKUP_DIR" && pwd -P)"
case "$backup_root/" in
  "$repo_root/"*) printf 'Backups must be written outside the repository.\n' >&2; exit 1 ;;
esac
chmod 700 "$backup_root"

compose=(docker compose --project-name codex-status-dashboard-provider-runtime \
  --file "$repo_root/deploy/compose.provider-runtime.yaml" \
  --env-file "$repo_root/.env")
worker_was_running=0
if [[ -n "$("${compose[@]}" ps --status running --quiet worker 2>/dev/null)" ]]; then
  worker_was_running=1
fi
restart_worker() {
  if [[ -n "${workdir:-}" && -d "$workdir" ]]; then rm -rf "$workdir"; fi
  if (( worker_was_running )); then
    "${compose[@]}" start worker >/dev/null 2>&1 || printf 'Provider Runtime remains stopped; start it with Docker Compose.\n' >&2
  fi
}
if (( worker_was_running )); then "${compose[@]}" stop worker >/dev/null; fi
trap restart_worker EXIT

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
workdir="$(mktemp -d "$backup_root/.codex-status-dashboard-backup.XXXXXXXX")"
chmod 700 "$workdir"
archive="$backup_root/codex-status-dashboard-$timestamp-${workdir##*.}.tar.gz"

if ! pg_dump --no-password --format=custom --file="$workdir/database.dump" --dbname="$DATABASE_DIRECT_URL" 2>/dev/null; then
  printf 'Database backup failed; the database error was suppressed to avoid exposing connection details.\n' >&2
  exit 1
fi
if ! "${compose[@]}" run --rm --no-deps -T --entrypoint tar worker \
  -C /var/lib/dashboard-auth -czf - . >"$workdir/auth.tar.gz" 2>/dev/null; then
  printf 'Provider auth-volume backup failed.\n' >&2
  exit 1
fi
if ! tar -czf "$workdir/provider-config.tar.gz" -C "$repo_root/deploy" provider-accounts.json secrets 2>/dev/null; then
  printf 'Provider configuration backup failed.\n' >&2
  exit 1
fi

schema_versions="$(psql --no-password --dbname="$DATABASE_DIRECT_URL" -X -A -t -v ON_ERROR_STOP=1 \
  -c "SELECT COALESCE(string_agg(version, ',' ORDER BY version), '') FROM schema_migrations" 2>/dev/null || true)"
{
  printf 'created_at_utc=%s\n' "$timestamp"
  printf 'schema_versions=%s\n' "${schema_versions:-unavailable}"
  printf 'provider_auth_included=true\n'
  printf 'provider_config_included=true\n'
} >"$workdir/manifest.txt"
chmod 600 "$workdir"/*

if ! tar -czf "$archive" -C "$workdir" database.dump auth.tar.gz provider-config.tar.gz manifest.txt; then
  printf 'Could not package the protected backup.\n' >&2
  exit 1
fi
chmod 600 "$archive"
rm -rf "$workdir"
printf 'Backup created: %s\n' "$archive"
