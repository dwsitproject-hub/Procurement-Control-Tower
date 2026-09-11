#!/usr/bin/env bash
#
# Phase 4 — prove the new database is the old one.
#
# Read-only on both sides. Every check compares the target against a file
# written before the dump, never against a number someone remembers.
#
# Exit status is the verdict: 0 means cut over, non-zero means do not.

. "$(dirname "$0")/00-lib.sh"

[ -f "$WORKDIR/SOURCE_ROWS.txt" ] || { bad "no baseline -- run ./01-preflight.sh"; exit 1; }
STAMP="$(date +%Y%m%d-%H%M%S)"
REPORT="$WORKDIR/verify-$STAMP.txt"
FAILED=0

# Compare one object class. $1 is a label, $2 is SQL returning one sorted
# text column per object. The diff, not the count, is the output: "412 vs 411"
# tells you nothing about which index is missing.
cmp_class() {
  local label="$1" sql="$2"
  local a="$WORKDIR/.src.$3" b="$WORKDIR/.dst.$3"
  S "$sql" | sort > "$a"
  R "$sql" | sort > "$b"
  if diff -q "$a" "$b" >/dev/null; then
    ok "$label: $(wc -l < "$a") identical"
  else
    bad "$label differs:"
    diff "$a" "$b" | head -20 | sed 's/^/      /'
    FAILED=1
  fi
}

say "1-2. Tables and views"
cmp_class "tables" "SELECT n.nspname||'.'||c.relname||' '||c.relkind::text
                      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                     WHERE c.relkind IN ('r','p') AND n.nspname IN ($PCT_SCHEMAS)" tables
cmp_class "views" "SELECT n.nspname||'.'||c.relname
                     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                    WHERE c.relkind = 'v' AND n.nspname IN ($PCT_SCHEMAS)" views

say "3. Columns and types"
# Catches a column that arrived with the wrong type, which no count would.
cmp_class "columns" "SELECT table_schema||'.'||table_name||'.'||column_name||' '||data_type
                       FROM information_schema.columns
                      WHERE table_schema IN ($PCT_SCHEMAS)" columns

say "4. Indexes"
cmp_class "indexes" "SELECT schemaname||'.'||indexname FROM pg_indexes
                      WHERE schemaname IN ($PCT_SCHEMAS)" indexes

say "5. Constraints"
# PG18 materialises NOT NULL as a pg_constraint row with contype='n'; PG16 does
# not. Comparing a 16 source with an 18 target without excluding it produces
# hundreds of phantom differences. contype is "char", which does not compare
# cleanly across versions in a generated query either, hence the ::text.
cmp_class "constraints" "SELECT n.nspname||'.'||t.relname||'.'||c.conname||' '||c.contype::text
                           FROM pg_constraint c
                           JOIN pg_class t ON t.oid = c.conrelid
                           JOIN pg_namespace n ON n.oid = t.relnamespace
                          WHERE n.nspname IN ($PCT_SCHEMAS)
                            AND c.contype::text <> 'n'" constraints

say "6. Functions"
cmp_class "functions" "SELECT n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')'
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname IN ($PCT_SCHEMAS)
                          AND NOT EXISTS (SELECT 1 FROM pg_depend d
                                           WHERE d.objid = p.oid AND d.deptype = 'e')" functions

say "7. Partitions per parent"
# Six parents, twelve partitions each on the source. A parent that arrives
# with fewer children still answers queries -- it just silently returns less.
cmp_class "partitions" "SELECT p.relname||'|'||count(*) FROM pg_inherits i
                          JOIN pg_class p ON p.oid = i.inhparent
                          JOIN pg_namespace n ON n.oid = p.relnamespace
                         WHERE n.nspname IN ($PCT_SCHEMAS) AND p.relkind = 'p'
                         GROUP BY p.relname" partitions

say "8. Sequences and their current values"
# A sequence restored at its default start hands out primary keys that already
# exist. pg_dump does carry setval, so this check is about proving it did.
SEQS_SQL="SELECT schemaname||'.'||sequencename||'|'||COALESCE(last_value::text,'unset')
            FROM pg_sequences WHERE schemaname IN ($PCT_SCHEMAS) ORDER BY 1"
R "$SEQS_SQL" | sort > "$WORKDIR/.dst.seqs"
sort "$WORKDIR/SOURCE_SEQS.txt" > "$WORKDIR/.src.seqs"
if diff -q "$WORKDIR/.src.seqs" "$WORKDIR/.dst.seqs" >/dev/null; then
  ok "sequences: $(wc -l < "$WORKDIR/.src.seqs") identical, values included"
else
  bad "sequence values differ:"
  diff "$WORKDIR/.src.seqs" "$WORKDIR/.dst.seqs" | head -20 | sed 's/^/      /'
  FAILED=1
fi

say "9. Row counts, table by table"
# Counted on the target, diffed against the file captured before the dump.
# Parents aggregate their partitions, so a missing partition shows up here as
# well as in check 7.
ROWS_SQL="SELECT n.nspname||'.'||c.relname,
                 (xpath('/row/c/text()',
                        query_to_xml(format('select count(*) as c from %I.%I', n.nspname, c.relname),
                                     false, true, '')))[1]::text::bigint
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE c.relkind IN ('r','p') AND NOT c.relispartition
             AND n.nspname IN ($PCT_SCHEMAS)
           ORDER BY 1"
R "$ROWS_SQL" | sort > "$WORKDIR/.dst.rows"
sort "$WORKDIR/SOURCE_ROWS.txt" > "$WORKDIR/.src.rows"
if diff -q "$WORKDIR/.src.rows" "$WORKDIR/.dst.rows" >/dev/null; then
  TOTAL="$(awk -F'|' '{s+=$2} END {print s+0}' "$WORKDIR/.src.rows")"
  ok "row counts identical across $(wc -l < "$WORKDIR/.src.rows") tables ($TOTAL rows)"
else
  bad "row counts differ (source | target):"
  diff "$WORKDIR/.src.rows" "$WORKDIR/.dst.rows" | head -30 | sed 's/^/      /'
  FAILED=1
fi

say "10. Application state this dashboard depends on"
# Not object counts but the handful of facts that decide whether the app comes
# back up showing the same numbers.
SRC_MIG="$(cat "$WORKDIR/SOURCE_MIGRATIONS.txt")"
DST_MIG="$(R 'SELECT count(*) FROM public.schema_migration')"
if [ "$SRC_MIG" = "$DST_MIG" ]; then
  ok "schema_migration: $DST_MIG rows -- the API will skip, not re-run, migrations"
else
  bad "schema_migration: $SRC_MIG on the source, $DST_MIG on the target."
  bad "The API re-runs migrations at boot; a short table means it will try to"
  bad "apply them again over restored data."
  FAILED=1
fi

# The published version is the single fact the dashboard cannot do without:
# every figure on every page is read from it. So it is COMPARED, not merely
# printed -- an earlier version of this line printed the target's value only,
# and compared status against 'published' when the column stores 'PUBLISHED',
# so it reported "none" on a database that had one. Hence upper() here, and
# hence cmp_class rather than a bare R.
cmp_class "published version" "SELECT COALESCE(
            (SELECT 'v'||id::text FROM core.dataset_version
              WHERE upper(status) = 'PUBLISHED'
              ORDER BY published_at DESC NULLS LAST LIMIT 1),
            'NONE PUBLISHED')" published

R "SELECT 'dataset versions by status: '||COALESCE(string_agg(s||'='||c, ', '),'-')
     FROM (SELECT upper(status) AS s, count(*)::text AS c
             FROM core.dataset_version GROUP BY 1 ORDER BY 1) t" | sed 's/^/  /'
R "SELECT 'chart series: '||count(*)||', with a drill predicate: '||
          count(*) FILTER (WHERE drill_predicate IS NOT NULL) FROM mart.chart_series" | sed 's/^/  /'
R "SELECT 'rule_config rows: '||count(*) FROM app.rule_config" | sed 's/^/  /'
R "SELECT 'app users: '||count(*)||', page permissions: '||
          (SELECT count(*) FROM app.page_permission) FROM app.app_user" | sed 's/^/  /'

say "Verdict"
{
  echo "PCT staging -> ApsaraDB verification, $STAMP"
  echo "source: $SRC_HOST:$SRC_PORT/$SRC_DB"
  echo "target: $DST_HOST:$DST_PORT/$DST_DB"
  echo "result: $([ "$FAILED" = 0 ] && echo PASS || echo FAIL)"
} > "$REPORT"
if [ "$FAILED" = "0" ]; then
  ok "all ten checks passed -- report written to $(basename "$REPORT")"
  ok "./05-cutover.sh   (repoints the API and starts it)"
else
  bad "verification FAILED -- do not cut over. The old database is untouched"
  bad "and still holds everything; the API is simply stopped."
  exit 1
fi
