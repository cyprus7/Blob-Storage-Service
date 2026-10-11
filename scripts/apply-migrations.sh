#!/bin/sh
set -eu

if [ -n "${BLOB_PG_URL:-}" ]; then
  database_url="$BLOB_PG_URL"
else
  export PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
  host="${POSTGRES_HOST:-postgres}"
  user="${POSTGRES_USER:?POSTGRES_USER is required}"
  database="${POSTGRES_DB:?POSTGRES_DB is required}"
fi
migrations_dir="${MIGRATIONS_DIR:-/app/migrations/blob-service}"

psql_db() {
  if [ -n "${database_url:-}" ]; then
    psql "$database_url" "$@"
  else
    psql -h "$host" -U "$user" -d "$database" "$@"
  fi
}

pg_ready() {
  if [ -n "${database_url:-}" ]; then
    pg_isready -d "$database_url" >/dev/null 2>&1
  else
    pg_isready -h "$host" -U "$user" -d "$database" >/dev/null 2>&1
  fi
}

attempt=0
until pg_ready; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo 'PostgreSQL did not become ready within 60 seconds' >&2
    exit 1
  fi
  sleep 1
done

psql_db -v ON_ERROR_STOP=1 \
  -c 'CREATE TABLE IF NOT EXISTS blob_schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'

for migration in "$migrations_dir"/[0-9]*.sql; do
  [ -f "$migration" ] || continue
  name="$(basename "$migration")"
  applied="$(psql_db -At -v ON_ERROR_STOP=1 \
    -v migration_name="$name" <<'SQL'
SELECT EXISTS (SELECT 1 FROM blob_schema_migrations WHERE name = :'migration_name');
SQL
  )"
  if [ "$applied" = 't' ]; then
    echo "Already applied: $name"
    continue
  fi

  echo "Applying: $name"
  psql_db -v ON_ERROR_STOP=1 \
    -v migration_name="$name" <<SQL
BEGIN;
\i $migration
INSERT INTO blob_schema_migrations(name) VALUES (:'migration_name');
COMMIT;
SQL
done
