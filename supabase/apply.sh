#!/usr/bin/env bash
# Apply the SQL files a Supabase project still needs, in order, with psql. Tracks what ran.
#
#   bash supabase/apply.sh core    "$CORE_DB_URL"                  apply pending files
#   bash supabase/apply.sh core    "$CORE_DB_URL" --dry-run        list applied / pending, change nothing
#   bash supabase/apply.sh core    "$CORE_DB_URL" --mark-applied   record every file as applied WITHOUT running it
#   bash supabase/apply.sh content "$CONTENT_DB_URL" ...           same for the content project
#
# Connection strings: Supabase dashboard -> Project Settings -> Database -> Connection string (URI).
#
# Tracking: table public.apstat_park_migrations(name, sha256, applied_at), created on first real run.
# `name` is the file path relative to the repo root; `sha256` is of the file with CR stripped (so a CRLF
# checkout matches an LF one). Only files NOT in that table run. Each file runs in its own psql
# --single-transaction together with its tracking insert, so a failing file leaves nothing behind
# (files that contain their own BEGIN/COMMIT are atomic on their own; their tracking row follows).
# The chain is NOT safe to replay on a populated database: older migrations replace constraints and
# functions that later ones extended. On a project that was migrated by hand before this table existed,
# run --mark-applied once instead.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
project="${1:-}"
url="${2:-}"
mode="${3:-apply}"

usage() {
  echo "usage: apply.sh <core|content> <postgres-url> [--dry-run|--mark-applied]" >&2
  exit 2
}

[ -n "$project" ] || usage
[ -n "$url" ] || usage
case "$mode" in
  apply|--dry-run|--mark-applied) ;;
  *) usage ;;
esac

# ---- the ordered file list per project ----
files=()
sentinel=""
case "$project" in
  core)
    # Baselines and core fixes (supabase/core/0*.sql), then relay and roster migrations, then storage (9*.sql).
    for f in "$here"/core/0*.sql;                     do files+=("$f"); done
    for f in "$root"/services/relay/migrations/*.sql;  do files+=("$f"); done
    for f in "$root"/services/roster/migrations/*.sql; do files+=("$f"); done
    for f in "$here"/core/9*.sql;                     do files+=("$f"); done
    sentinel="public.answers"
    ;;
  content)
    for f in "$here"/content/*.sql; do files+=("$f"); done
    sentinel="public.lesson_urls"
    ;;
  *)
    echo "unknown project: $project" >&2
    exit 2
    ;;
esac

command -v psql >/dev/null || { echo "psql not found on PATH" >&2; exit 2; }

# ---- helpers ----
q() {
  psql "$url" -X -q -t -A -v ON_ERROR_STOP=1 -c "$1"
}

rel() {
  local f="$1"
  echo "${f#"$root"/}"
}

checksum() {
  tr -d '\r' < "$1" | sha256sum | cut -d' ' -f1
}

record_sql() {
  local name="$1" sum="$2"
  echo "insert into public.apstat_park_migrations (name, sha256) values ('$name', '$sum')
        on conflict (name) do update set sha256 = excluded.sha256, applied_at = now();"
}

create_tracking_table() {
  q "create table if not exists public.apstat_park_migrations (
       name       text primary key,
       sha256     text not null,
       applied_at timestamptz not null default now()
     );
     alter table public.apstat_park_migrations enable row level security;" >/dev/null
}

# ---- what has already run ----
declare -A applied=()
table_exists="$(q "select to_regclass('public.apstat_park_migrations') is not null")"
if [ "$table_exists" = "t" ]; then
  while IFS='|' read -r name sum; do
    [ -n "$name" ] && applied["$name"]="$sum"
  done < <(q "select name, sha256 from public.apstat_park_migrations")
fi

pending=()
for f in "${files[@]}"; do
  name="$(rel "$f")"
  sum="$(checksum "$f")"
  if [ -z "${applied[$name]:-}" ]; then
    pending+=("$f")
    continue
  fi
  if [ "${applied[$name]}" != "$sum" ]; then
    echo "changed  $name (applied with a different checksum; NOT re-run, review it by hand)"
    continue
  fi
  echo "applied  $name"
done
for f in "${pending[@]}"; do echo "pending  $(rel "$f")"; done
echo "$project: ${#files[@]} files, $(( ${#files[@]} - ${#pending[@]} )) applied, ${#pending[@]} pending"

if [ "$mode" = "--dry-run" ]; then
  exit 0
fi
if [ "${#pending[@]}" -eq 0 ]; then
  echo "nothing to do"
  exit 0
fi

# ---- baseline an already-migrated project ----
if [ "$mode" = "--mark-applied" ]; then
  create_tracking_table
  for f in "${pending[@]}"; do
    q "$(record_sql "$(rel "$f")" "$(checksum "$f")")" >/dev/null
    echo "marked   $(rel "$f")"
  done
  echo "done: ${#pending[@]} files recorded as applied (none were run)"
  exit 0
fi

# ---- safety: an untracked but populated project must be baselined first ----
if [ "${#applied[@]}" -eq 0 ]; then
  has_sentinel="$(q "select to_regclass('$sentinel') is not null")"
  if [ "$has_sentinel" = "t" ]; then
    echo "refusing: $sentinel already exists but nothing is recorded in public.apstat_park_migrations." >&2
    echo "This project was migrated before tracking existed. Replaying the chain is NOT safe." >&2
    echo "Run once:  bash supabase/apply.sh $project <url> --mark-applied" >&2
    echo "then apply only files that are genuinely new." >&2
    exit 1
  fi
fi

# ---- apply pending files, one transaction each ----
create_tracking_table
for f in "${pending[@]}"; do
  name="$(rel "$f")"
  echo "== applying $name"
  psql "$url" -X -q -v ON_ERROR_STOP=1 --single-transaction -f "$f" -c "$(record_sql "$name" "$(checksum "$f")")"
done
echo "done: ${#pending[@]} files applied to $project"
