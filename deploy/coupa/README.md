# Changing the Coupa tenant

What to run when `COUPA_BASE_URL` is moved from one Coupa tenant to another —
on staging, 21 Sep 2026, from `https://kpn-test.coupahost.com` to production.

## Why anything has to be deleted

Coupa ids are per-tenant. The sync upserts on that id, so a production row does
not overwrite the test row that shares its table — it sits next to it. Nothing
in the app knows the two came from different tenants, so every Coupa figure
would be the two tenants added together, permanently.

Two more things do not fix themselves:

- **`ops.coupa_watermark`** advances with `GREATEST(...)`, so a cursor can never
  move backwards. The first production run would ask for "everything changed
  since <a timestamp from the test tenant>" and get almost nothing back.
- **`ops.fx_rate_source`** is shared with SAP (migration 010) — one row per
  currency pair and period, most recently updated source wins. The test tenant
  quotes USD→IDR at about 17.8 instead of 16,800, and where those won a period
  they are why staging's PR Pipeline reads about $76 B.

## What the purge does and does not touch

| | |
|---|---|
| truncated | every `ops.coupa_*` table (raw, sourcing, responses, suppliers, PO lines, receipts, invoices, invoice lines, payments, exchange rates) |
| truncated | `ops.coupa_watermark` — makes the next run a cold full pull |
| `DELETE WHERE source='coupa'` | `ops.fx_rate_source` — **the SAP rows must survive** |
| untouched | everything in `core.*`, `ingest.*`, audit and notify history |

One consequence to know before running: where a Coupa rate had won a period, the
delete removes the pair rather than reverting it — a pair keeps one row and the
SAP value it overwrote is not kept anywhere. The SAP rate comes back at the next
transform, which re-upserts the whole rate file.

## Running it

Copy both files to the API server next to `staging.env`, then:

```bash
cd /opt/pct
bash purge-coupa-tenant-data.sh          # dry run — counts only, changes nothing
bash purge-coupa-tenant-data.sh --yes    # guard, backup, purge
```

The script refuses to run while the container still points at the old tenant
(`OLD_HOST_MATCH`, default `-test.`), refuses while a sync holds the sync lock,
and dumps every affected table to `coupa-purge-backup/` before deleting
anything. The SQL can also be run on its own:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f purge-coupa-tenant-data.sql
```

## Afterwards, in order

1. **Admin → Coupa → Sync now.** Watermarks are gone, so this is a cold full
   pull — far longer than a poll tick. It keeps running after the request
   returns; the page polls per-object progress.
2. **Admin → SAP Data Upload → Recompute.** The published dataset still holds
   `core.fx_rate` rows built from the old tenant's rates. Nothing on screen
   changes until a recompute rebuilds them from `ops.fx_rate_source`.
3. Check Admin → FX: the provenance column should show the new tenant's rates,
   and USD→IDR should read in the thousands for every period.
