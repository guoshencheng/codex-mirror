#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
archive="${1:-}"
: "${RESTORE_DATABASE_DIRECT_URL:?Set this to a newly created isolated restore/test database URL; production is refused}"
: "${RESTORE_OUTPUT_DIR:?Set this to a new, protected directory outside the checkout}"
[[ "${RESTORE_CONFIRM:-}" == 'restore-into-isolated-empty-database' ]] || {
  printf 'Set RESTORE_CONFIRM=restore-into-isolated-empty-database after creating an isolated target database.\n' >&2
  exit 1
}
[[ -n "$archive" && -f "$archive" ]] || { printf 'Usage: scripts/restore.sh /path/to/codex-status-dashboard-backup.tar.gz\n' >&2; exit 1; }
for command in pg_restore psql tar; do
  command -v "$command" >/dev/null 2>&1 || { printf 'Required command missing: %s\n' "$command" >&2; exit 1; }
done

mkdir -p "$(dirname "$RESTORE_OUTPUT_DIR")"
restore_parent="$(cd "$(dirname "$RESTORE_OUTPUT_DIR")" && pwd -P)"
case "$restore_parent/$(basename "$RESTORE_OUTPUT_DIR")/" in
  "$repo_root/"*) printf 'Restore files must be written outside the repository.\n' >&2; exit 1 ;;
esac
[[ ! -e "$RESTORE_OUTPUT_DIR" ]] || { printf 'RESTORE_OUTPUT_DIR must not already exist.\n' >&2; exit 1; }
mkdir -m 700 "$RESTORE_OUTPUT_DIR"

workdir="$(mktemp -d "${TMPDIR:-/tmp}/codex-status-dashboard-restore.XXXXXXXX")"
chmod 700 "$workdir"
cleanup() { rm -rf "$workdir"; }
trap cleanup EXIT

while IFS= read -r member; do
  case "$member" in
    database.dump|auth.tar.gz|provider-config.tar.gz|manifest.txt) ;;
    *) printf 'Backup archive contains an unexpected path; refusing extraction.\n' >&2; exit 1 ;;
  esac
done < <(tar -tzf "$archive")
if ! tar -xzf "$archive" -C "$workdir" --no-same-owner --no-same-permissions 2>/dev/null; then
  printf 'Could not read the backup archive.\n' >&2
  exit 1
fi
for required in database.dump auth.tar.gz provider-config.tar.gz manifest.txt; do
  [[ -f "$workdir/$required" && ! -L "$workdir/$required" ]] || { printf 'Backup is missing a required file.\n' >&2; exit 1; }
done

database_name="$(psql --no-password --dbname="$RESTORE_DATABASE_DIRECT_URL" -X -A -t -v ON_ERROR_STOP=1 \
  -c 'SELECT current_database()' 2>/dev/null || true)"
case "$database_name" in
  *_restore|*_test|*_staging) ;;
  *) printf 'Restore target database name must end in _restore, _test, or _staging.\n' >&2; exit 1 ;;
esac
existing_tables="$(psql --no-password --dbname="$RESTORE_DATABASE_DIRECT_URL" -X -A -t -v ON_ERROR_STOP=1 \
  -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f','S')" 2>/dev/null || true)"
[[ "$existing_tables" == '0' ]] || { printf 'Restore target contains application tables; no data was overwritten.\n' >&2; exit 1; }

if ! pg_restore --no-password --single-transaction --exit-on-error --no-owner --no-privileges \
  --dbname="$RESTORE_DATABASE_DIRECT_URL" "$workdir/database.dump" 2>/dev/null; then
  printf 'Database restore failed. Existing database objects were not dropped or cleaned.\n' >&2
  exit 1
fi

expected_versions="$(find "$repo_root/migrations" -maxdepth 1 -type f -name '[0-9][0-9][0-9]-*.sql' -printf '%f\n' | LC_ALL=C sort | paste -sd, -)"
actual_versions="$(psql --no-password --dbname="$RESTORE_DATABASE_DIRECT_URL" -X -A -t -v ON_ERROR_STOP=1 \
  -c "SELECT COALESCE(string_agg(version, ',' ORDER BY version), '') FROM schema_migrations" 2>/dev/null || true)"
[[ -n "$expected_versions" && "$actual_versions" == "$expected_versions" ]] || {
  printf 'Restore completed, but schema_migrations does not match this checkout. Review the isolated target before use.\n' >&2
  exit 1
}

mkdir -m 700 "$RESTORE_OUTPUT_DIR/provider-runtime" "$RESTORE_OUTPUT_DIR/auth"
while IFS= read -r member; do
  case "$member" in
    provider-accounts.json|secrets|secrets/*) ;;
    *) printf 'Provider config archive contains an unexpected path; refusing extraction.\n' >&2; exit 1 ;;
  esac
done < <(tar -tzf "$workdir/provider-config.tar.gz")
if ! tar -xzf "$workdir/provider-config.tar.gz" -C "$RESTORE_OUTPUT_DIR/provider-runtime" \
  --no-same-owner --no-same-permissions 2>/dev/null; then
  printf 'Could not extract provider configuration.\n' >&2
  exit 1
fi
while IFS= read -r member; do
  case "$member" in
    .|./|./*)
      [[ "$member" != *'../'* && "$member" != ../* && "$member" != /* ]] || {
        printf 'Auth archive contains an unsafe path; refusing extraction.\n' >&2; exit 1;
      }
      ;;
    *) printf 'Auth archive contains an unexpected path; refusing extraction.\n' >&2; exit 1 ;;
  esac
done < <(tar -tzf "$workdir/auth.tar.gz")
if ! tar -xzf "$workdir/auth.tar.gz" -C "$RESTORE_OUTPUT_DIR/auth" \
  --no-same-owner --no-same-permissions 2>/dev/null; then
  printf 'Could not extract Provider Runtime auth data.\n' >&2
  exit 1
fi
cp "$workdir/manifest.txt" "$RESTORE_OUTPUT_DIR/manifest.txt"
chmod -R go-rwx "$RESTORE_OUTPUT_DIR"
printf 'Database restored to isolated target %s. Protected runtime files are in %s; they have not been applied to a running service.\n' \
  "$database_name" "$RESTORE_OUTPUT_DIR"
