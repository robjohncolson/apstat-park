#!/usr/bin/env bash
# Apply every SQL file a Supabase project needs, in order, with psql.
#   bash supabase/apply.sh core    "$CORE_DB_URL"
#   bash supabase/apply.sh content "$CONTENT_DB_URL"
# Connection strings: Supabase dashboard -> Project Settings -> Database -> Connection string (URI).
# Every file is idempotent; re-run after a sync brings in a new migration.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/.." && pwd)"
project="${1:-}"; url="${2:-}"
[ -n "$project" ] && [ -n "$url" ] || { echo "usage: apply.sh <core|content> <postgres-url>" >&2; exit 2; }

files=()
case "$project" in
  core)
    files+=("$here/core/000_quiz_baseline.sql" "$here/core/001_user_settings.sql")
    for f in "$root"/services/relay/migrations/*.sql;  do files+=("$f"); done
    for f in "$root"/services/roster/migrations/*.sql; do files+=("$f"); done
    files+=("$here/core/900_pc_figures_bucket.sql")
    ;;
  content)
    files+=("$here/content/000_roadmap_baseline.sql" "$here/content/001_summer_2026_progress.sql" "$here/content/900_trainer_assets_bucket.sql")
    ;;
  *) echo "unknown project: $project" >&2; exit 2;;
esac

for f in "${files[@]}"; do
  echo "== $(realpath --relative-to="$root" "$f" 2>/dev/null || echo "$f")"
  psql "$url" -v ON_ERROR_STOP=1 -q -f "$f"
done
echo "done: ${#files[@]} files applied to $project"
