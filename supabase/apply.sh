#!/usr/bin/env bash
# Apply the SQL files a Supabase project still needs, in order, with psql. Tracks what ran.
#
#   bash supabase/apply.sh core    "$CORE_DB_URL"                  apply pending files
#   bash supabase/apply.sh core    "$CORE_DB_URL" --dry-run        list applied / pending, run the safety checks, change nothing
#   bash supabase/apply.sh core    "$CORE_DB_URL" --mark-applied   record every pending file as applied WITHOUT running it
#   bash supabase/apply.sh content "$CONTENT_DB_URL" ...           same for the content project
#
# Needs: bash 3.2+ (macOS Terminal, Linux, Git Bash on Windows), psql, node, and sha256sum or shasum.
# Connection strings: Supabase dashboard -> Project Settings -> Database -> Connection string (URI).
#
# Tracking: table public.apstat_park_migrations(name, sha256, applied_at), created on the first real run.
# `name` is the file path relative to the repo root; `sha256` is of the file with CR stripped (so a CRLF
# checkout matches an LF one). One extra row, name '__history__', records how the history started:
# 'fresh' (this script built the project from nothing) or 'baseline:<n>' (--mark-applied recorded n files).
#
# Atomicity: each pending file runs in ONE psql session as
#     BEGIN;  <execution copy of the file>;  INSERT its tracking row;  COMMIT;
# so the schema change and its tracking row commit together or not at all. Transactions do not nest, and
# psql's --single-transaction does nothing for a file that has its own BEGIN/COMMIT (roster 0032-0035,
# 0039, 0041 do). So the execution copy is the file with its own top-level `begin;` / `commit;` lines
# removed (supabase/apply-helper.mjs). The helper refuses, before anything runs, any file whose
# transaction control it cannot classify or that holds a statement that cannot run in a transaction
# (CONCURRENTLY, VACUUM, ...). The mirrored migration files themselves are never edited.
#
# The chain is NOT safe to replay on a populated database: older migrations replace constraints and
# functions that later ones extended. On a project that was migrated by hand before this table existed,
# run --mark-applied once instead. It records the whole baseline in one transaction.
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

die() {
  echo "apply.sh: $*" >&2
  exit 1
}

[ -n "$project" ] || usage
[ -n "$url" ] || usage
case "$mode" in
  apply|--dry-run|--mark-applied) ;;
  *) usage ;;
esac

# ---- the ordered file list per project (supabase/README.md "Fresh install" lists the same order) ----
files=()
other_project=""
case "$project" in
  core)
    # Baselines and core fixes (supabase/core/0*.sql), then relay and roster migrations, then storage (9*.sql).
    for f in "$here"/core/0*.sql;                     do files+=("$f"); done
    for f in "$root"/services/relay/migrations/*.sql;  do files+=("$f"); done
    for f in "$root"/services/roster/migrations/*.sql; do files+=("$f"); done
    for f in "$here"/core/9*.sql;                     do files+=("$f"); done
    other_project="content"
    ;;
  content)
    for f in "$here"/content/*.sql; do files+=("$f"); done
    other_project="core"
    ;;
  *)
    echo "unknown project: $project" >&2
    exit 2
    ;;
esac

# ---- tools ----
command -v psql >/dev/null || die "psql not found on PATH (or use the SQL editor path in supabase/README.md)"
command -v node >/dev/null || die "node not found on PATH (INSTALL step 0)"

# macOS has shasum, Linux and Git Bash have sha256sum. Both print "<hex>  -".
if command -v sha256sum >/dev/null; then
  sha256() { sha256sum; }
elif command -v shasum >/dev/null; then
  sha256() { shasum -a 256; }
else
  die "neither sha256sum nor shasum found on PATH"
fi

# ---- helpers ----

# One read-only query. Callers check its exit status: a failed read must never look like "nothing there".
q() {
  psql "$url" -X -q -t -A -v ON_ERROR_STOP=1 -c "$1"
}

rel() {
  echo "${1#"$root"/}"
}

checksum() {
  tr -d '\r' < "$1" | sha256 | cut -d' ' -f1
}

# Quote a value as an SQL string literal.
sql_literal() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/''/g")"
}

record_sql() {
  echo "insert into public.apstat_park_migrations (name, sha256) values ($(sql_literal "$1"), $(sql_literal "$2"))
        on conflict (name) do update set sha256 = excluded.sha256, applied_at = now();"
}

# Write the '__history__' row only if there is none yet: the first writer decides how history started.
history_sql() {
  echo "insert into public.apstat_park_migrations (name, sha256) values ('__history__', $(sql_literal "$1"))
        on conflict (name) do nothing;"
}

create_tracking_sql() {
  echo "create table if not exists public.apstat_park_migrations (
          name       text primary key,
          sha256     text not null,
          applied_at timestamptz not null default now()
        );
        alter table public.apstat_park_migrations enable row level security;"
}

# The checksum recorded for a file, or nothing. Rows are "name|sha256" lines in $applied_rows.
recorded_sum() {
  printf '%s\n' "$applied_rows" | awk -F'|' -v n="$1" '$1 == n { print $2 }'
}

# Lines of $1 that are also lines of $2 (both newline-separated lists).
present_in() {
  local wanted="$1" have="$2" t
  for t in $wanted; do
    if printf '%s\n' "$have" | grep -qxF -- "$t"; then echo "$t"; fi
  done
}

count_lines() {
  if [ -z "$1" ]; then echo 0; return; fi
  printf '%s\n' "$1" | wc -l | tr -d ' '
}

one_line() {
  printf '%s\n' "$1" | paste -sd' ' -
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# ---- read the database (every read checked; abort before planning or changing anything) ----
if ! tracking_exists="$(q "select to_regclass('public.apstat_park_migrations') is not null")"; then
  die "could not query the database (connection string, password, network?). Nothing was changed."
fi

applied_rows=""
if [ "$tracking_exists" = "t" ]; then
  if ! applied_rows="$(q "select name, sha256 from public.apstat_park_migrations order by name")"; then
    die "could not read public.apstat_park_migrations. Nothing was changed."
  fi
fi

if ! db_tables="$(q "select table_name from information_schema.tables where table_schema = 'public' order by 1")"; then
  die "could not list the tables in the public schema. Nothing was changed."
fi

if ! own_expected="$(node "$here/apply-helper.mjs" tables "$project")"; then
  die "could not read supabase/expected-tables.json"
fi
if ! other_expected="$(node "$here/apply-helper.mjs" tables "$other_project")"; then
  die "could not read supabase/expected-tables.json"
fi

history="$(recorded_sum "__history__")"
file_rows="$(printf '%s\n' "$applied_rows" | grep -v '^__' | grep -v '^$' || true)"
own_present="$(present_in "$own_expected" "$db_tables")"
other_present="$(present_in "$other_expected" "$db_tables")"
own_missing="$(for t in $own_expected; do printf '%s\n' "$own_present" | grep -qxF -- "$t" || echo "$t"; done)"

# ---- plan: applied / changed / pending ----
pending=()
for f in "${files[@]}"; do
  name="$(rel "$f")"
  sum="$(checksum "$f")"
  was="$(recorded_sum "$name")"
  if [ -z "$was" ]; then
    pending+=("$f")
    continue
  fi
  if [ "$was" != "$sum" ]; then
    echo "changed  $name (applied with a different checksum; NOT re-run, review it by hand)"
    continue
  fi
  echo "applied  $name"
done
if [ "${#pending[@]}" -gt 0 ]; then
  for f in "${pending[@]}"; do echo "pending  $(rel "$f")"; done
fi
echo "$project: ${#files[@]} files, $(( ${#files[@]} - ${#pending[@]} )) applied, ${#pending[@]} pending"

# ---- safety checks (also in --dry-run, so a dry run says whether a real run would proceed) ----

# Wrong connection string: this database holds the other project's tables.
if [ -n "$other_present" ]; then
  die "refusing: this database has $(count_lines "$other_present") table(s) of the $other_project project ($(one_line "$other_present")).
Did you pass the $other_project project's connection string as $project? Check the URL and try again."
fi

if [ "$mode" = "--mark-applied" ]; then
  # Marking files as applied on a project that has none of their tables would make the history a lie.
  if [ -z "$own_present" ]; then
    die "refusing: --mark-applied is for a project that is already migrated, but this one has none of the
$project tables listed in supabase/expected-tables.json. Run without --mark-applied to build it."
  fi
  if [ -n "$own_missing" ]; then
    echo "WARNING: these expected $project tables are missing: $(one_line "$own_missing")." >&2
    echo "WARNING: --mark-applied will still record every pending file; make sure that is true." >&2
  fi
else
  # A history row count without a '__history__' row means a baseline that never finished (an older
  # apply.sh recorded one file per session). Running the rest would replay history on a live schema.
  if [ -n "$file_rows" ] && [ -z "$history" ]; then
    die "refusing: public.apstat_park_migrations has $(count_lines "$file_rows") rows but no '__history__' row,
so an earlier --mark-applied did not finish. After confirming the project is fully migrated, run:
  bash supabase/apply.sh $project <url> --mark-applied
It records the remaining files without running any of them."
  fi
  # Populated but untracked: migrated by hand before tracking existed.
  if [ -z "$file_rows" ] && [ -n "$own_present" ]; then
    die "refusing: this project already has $(count_lines "$own_present") application tables ($(one_line "$own_present"))
but no migration history. Replaying the chain is NOT safe. Run --mark-applied after confirming it is fully migrated:
  bash supabase/apply.sh $project <url> --mark-applied
then apply only files that are genuinely new."
  fi
fi

if [ "$mode" = "--dry-run" ]; then
  echo "dry run: safety checks passed, nothing changed"
  exit 0
fi

# ---- --mark-applied: record the whole baseline in ONE transaction, run nothing ----
if [ "$mode" = "--mark-applied" ]; then
  if [ "${#pending[@]}" -eq 0 ] && [ -n "$history" ]; then
    echo "nothing to do"
    exit 0
  fi
  total=$(( $(count_lines "$file_rows") + ${#pending[@]} ))
  script="$tmp/mark-applied.sql"
  {
    echo "begin;"
    create_tracking_sql
    if [ "${#pending[@]}" -gt 0 ]; then
      for f in "${pending[@]}"; do record_sql "$(rel "$f")" "$(checksum "$f")"; done
    fi
    history_sql "baseline:$total"
    echo "commit;"
  } > "$script"
  if ! psql "$url" -X -q -v ON_ERROR_STOP=1 -f "$script"; then
    die "--mark-applied failed; its transaction rolled back, nothing was recorded"
  fi
  if [ "${#pending[@]}" -gt 0 ]; then
    for f in "${pending[@]}"; do echo "marked   $(rel "$f")"; done
  fi
  echo "done: ${#pending[@]} files recorded as applied (none were run); baseline complete"
  exit 0
fi

# ---- apply ----
if [ "${#pending[@]}" -eq 0 ]; then
  echo "nothing to do"
  exit 0
fi

# Build every execution copy BEFORE running anything, so a file the stripper refuses stops the run
# while the database is still untouched. Each copy keeps the file's name, so psql errors name it.
n=0
for f in "${pending[@]}"; do
  n=$((n + 1))
  mkdir -p "$tmp/$n"
  if ! node "$here/apply-helper.mjs" strip "$f" > "$tmp/$n/$(basename "$f")"; then
    die "refusing to run $(rel "$f") (see the line above); nothing was changed.
Run it by hand in the SQL editor, then record it with:
  $(record_sql "$(rel "$f")" "$(checksum "$f")")"
  fi
done

# An empty table changes nothing about the safety checks, so creating it on its own is fine.
if ! psql "$url" -X -q -v ON_ERROR_STOP=1 -c "$(create_tracking_sql)"; then
  die "could not create public.apstat_park_migrations; nothing was changed"
fi

n=0
for f in "${pending[@]}"; do
  n=$((n + 1))
  name="$(rel "$f")"
  copy="$tmp/$n/$(basename "$f")"
  tracking="$(record_sql "$name" "$(checksum "$f")")"
  # The very first file on a fresh project also writes the '__history__' row, in the same transaction.
  if [ -z "$history" ]; then tracking="$tracking
$(history_sql fresh)"; fi
  echo "== applying $name"
  # One session: BEGIN, the file, its tracking row, COMMIT. ON_ERROR_STOP makes psql exit at the first
  # error; the open transaction then rolls back when the session ends, tracking row included.
  if ! psql "$url" -X -q -v ON_ERROR_STOP=1 -c "begin" -f "$copy" -c "$tracking" -c "commit"; then
    die "$name failed and was rolled back (its tracking row too). Fix the cause and re-run; files before it stay applied."
  fi
  if [ -z "$history" ]; then history="fresh"; fi
done
echo "done: ${#pending[@]} files applied to $project"
