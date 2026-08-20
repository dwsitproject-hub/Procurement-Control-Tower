import { useEffect, useState } from 'react';
import { api, type ChartResponse, type Kpi } from '../lib/api';
import { formatNumber } from '../lib/format';

/**
 * Executive Summary — the one page that states a conclusion rather than
 * presenting a measurement.
 *
 * Built from a reference design (20 Aug 2026) with four deliberate departures,
 * each because the original could not be reproduced honestly:
 *
 * 1. NO "HO vs UNIT" PANEL. The design showed Head Office holding 92% of value
 *    against 51% of PO lines. Measured here it is 2% / 17% — inverted — because
 *    NO Head-Office purchasing group appears in this entity's orders at all.
 *    The panel would have told the reader the opposite of the truth. Desk and
 *    vendor concentration carries the same strategic point (a few control the
 *    money, many run the paperwork) and is measurable.
 *
 * 2. "COMMITTED VALUE", NOT "SPEND". The figure is net order value: what was
 *    ORDERED. Calling it spend, as the design did, invites an argument with
 *    finance that the label settles for free.
 *
 * 3. THE PERIOD IS STATED, NOT IMPLIED. The design was headed "2025" and
 *    "annual spend" over what is in fact a part-year extract of one entity. The
 *    scope line below reads the dataset's own dates, so it cannot drift.
 *
 * 4. EVERY CLAIM IS COMPUTED. "top 5 = 70%" and "72% of lines < Rp 25 Jt = 4%
 *    of value" were static text. Here they are KPIs, swept for drill parity
 *    like everything else, so they cannot silently go stale.
 *
 * The action plan from the design is intentionally absent: it is a set of
 * commitments, not data, and static text in a live dashboard rots. It belongs
 * in the board pack, or in an admin-editable block if it must live here.
 */

interface Props {
  kpis: Kpi[];
  onDrill: (token: string, label: string) => void;
  currency: 'USD' | 'IDR';
  asOfDate: string | null;
  firstDate?: string | null;
}

/** Rupiah on the Jt / Bio / T ladder — ONE ladder, used everywhere on this page. */
function rupiah(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e12) return 'Rp ' + (v / 1e12).toFixed(2) + ' T';
  if (abs >= 1e9) return 'Rp ' + formatNumber(Math.round(v / 1e9)) + ' Bio';
  if (abs >= 1e6) return 'Rp ' + formatNumber(Math.round(v / 1e6)) + ' Jt';
  return 'Rp ' + formatNumber(Math.round(v));
}

function pct(v: number | null, dp = 1): string {
  return v === null || !Number.isFinite(v) ? '—' : v.toFixed(dp) + '%';
}

/**
 * A ranked horizontal bar list.
 *
 * Written rather than reusing ChartPanel's vertical bars because this is the
 * page's signature panel and the design is horizontal-and-ranked — and because
 * the ordering is the point. The reference chart was NOT correctly ranked (Coal
 * at 127 Bio sat below Bleaching Earth at 85), so the order here is derived
 * from the value itself and cannot be got wrong.
 *
 * `emphasiseTop` shades the leading N bars, matching the design's red/grey cut.
 * The design left that cut unexplained; the caption states it.
 */
function RankedBars({ data, onDrill, emphasiseTop }: {
  data: ChartResponse;
  onDrill: (token: string, label: string) => void;
  emphasiseTop: number;
}) {
  const series = data.series[0];
  if (!series) return <p className="muted">No data.</p>;

  const rows = series.points
    .map((p) => ({
      ...p,
      label: data.buckets.find((b) => b.key === p.bucketKey)?.label ?? p.bucketKey,
    }))
    .filter((r) => r.value !== null)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  const total = rows.reduce((a, r) => a + (r.value ?? 0), 0);
  const max = rows.reduce((a, r) => Math.max(a, r.value ?? 0), 0);

  return (
    <div className="xs-bars">
      {rows.map((r, i) => {
        const share = total > 0 ? ((r.value ?? 0) / total) * 100 : 0;
        const width = max > 0 ? ((r.value ?? 0) / max) * 100 : 0;
        return (
          <button
            key={r.bucketKey}
            type="button"
            className={'xs-bar-row' + (i < emphasiseTop ? ' xs-hi' : '')}
            disabled={!r.drillToken}
            title={r.drillToken ? formatNumber(r.rowCount) + ' PO lines — click to open' : undefined}
            onClick={() => r.drillToken && onDrill(r.drillToken, data.title + ' — ' + r.label)}
          >
            <span className="xs-bar-label">{r.label}</span>
            <span className="xs-bar-track">
              <span className="xs-bar-fill" style={{ width: width + '%' }} />
            </span>
            <span className="xs-bar-value">
              {rupiah(r.value)} <span className="muted">({share.toFixed(1)}%)</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The size-band panel: share of value against share of lines, on one band axis.
 *
 * Bands are ordered by the bucket ordinal, which is the band's own size rank —
 * never by measure. The reference design sorted these rows by % value and so
 * printed "100-500 Jt" above "500 Jt - 1 Bio"; on an interval scale that
 * destroys the distribution shape the panel exists to show.
 */
function BandPairs({ data, onDrill }: {
  data: ChartResponse;
  onDrill: (token: string, label: string) => void;
}) {
  const valueSeries = data.series.find((s) => s.key === 'value_share');
  const lineSeries = data.series.find((s) => s.key === 'line_share');
  if (!valueSeries || !lineSeries) return <p className="muted">No data.</p>;

  const buckets = [...data.buckets].sort((a, b) => a.ordinal - b.ordinal);

  return (
    <div className="xs-bands">
      {buckets.map((b) => {
        const v = valueSeries.points.find((p) => p.bucketKey === b.key) ?? null;
        const l = lineSeries.points.find((p) => p.bucketKey === b.key) ?? null;
        const token = v?.drillToken ?? l?.drillToken ?? null;
        return (
          <button
            key={b.key}
            type="button"
            className="xs-band-row"
            disabled={!token}
            title={token ? formatNumber(v?.rowCount ?? 0) + ' PO lines — click to open' : undefined}
            onClick={() => token && onDrill(token, data.title + ' — ' + b.label)}
          >
            <span className="xs-band-label">{b.label}</span>
            <span className="xs-band-bars">
              <span className="xs-band-line">
                <span className="xs-band-fill xs-v" style={{ width: (v?.value ?? 0) + '%' }} />
                <span className="xs-band-num">{pct(v?.value ?? 0)} of value</span>
              </span>
              <span className="xs-band-line">
                <span className="xs-band-fill xs-n" style={{ width: (l?.value ?? 0) + '%' }} />
                <span className="xs-band-num">{pct(l?.value ?? 0)} of lines</span>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

export function ExecSummaryTab({ kpis, onDrill, currency, asOfDate, firstDate }: Props) {
  const [byCategory, setByCategory] = useState<ChartResponse | null>(null);
  const [byBand, setByBand] = useState<ChartResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let dead = false;
    Promise.all([
      api.get<ChartResponse>('/api/v1/chart/exec_value_by_category'),
      api.get<ChartResponse>('/api/v1/chart/exec_txn_size'),
    ])
      .then(([c, b]) => { if (!dead) { setByCategory(c); setByBand(b); } })
      .catch((e: Error) => { if (!dead) setErr(e.message); });
    return () => { dead = true; };
  }, []);

  const k = (id: string): Kpi | undefined => kpis.find((x) => x.kpiId === id);
  const val = (id: string): number | null => k(id)?.value ?? null;

  // total_po_amount carries both bases, so the tile follows the user's display
  // currency instead of quietly mixing one into the other.
  const totalKpi = k('total_po_amount');
  // 'value_idr' is the key KpiCard reads; a different spelling here silently
  // showed a dash in IDR view.
  const totalIdr = (totalKpi?.detail?.['value_idr'] as number | null | undefined) ?? null;
  const totalUsd = totalKpi?.value ?? null;

  const tiles: { label: string; value: string; sub: string; kpi?: Kpi }[] = [
    {
      label: 'committed value',
      value: currency === 'IDR' && totalIdr !== null
        ? rupiah(totalIdr)
        : totalUsd !== null ? '$ ' + formatNumber(Math.round(totalUsd)) : '—',
      sub: 'net order value — STO and deleted excluded',
      ...(totalKpi ? { kpi: totalKpi } : {}),
    },
    {
      label: 'PO lines',
      value: formatNumber(val('po_line_items') ?? 0),
      sub: 'purchase lines in the period',
      ...(k('po_line_items') ? { kpi: k('po_line_items')! } : {}),
    },
    {
      label: 'active vendors',
      value: formatNumber(val('unique_suppliers') ?? 0),
      sub: 'distinct vendors ordered from',
      ...(k('unique_suppliers') ? { kpi: k('unique_suppliers')! } : {}),
    },
    {
      label: 'purchasing desks',
      value: formatNumber(val('active_purch_groups') ?? 0),
      sub: 'purchasing groups raising orders',
      ...(k('active_purch_groups') ? { kpi: k('active_purch_groups')! } : {}),
    },
  ];

  const top5 = val('top5_category_share_pct');
  const linesTail = val('lines_under_25jt_pct');
  const valueTail = val('value_under_25jt_pct');
  const desks80 = val('desks_for_80pct_value');
  const desksAll = val('active_purch_groups');
  const vend80 = val('vendors_for_80pct_value');
  const vendAll = val('unique_suppliers');
  const n = (v: number | null): string => (v === null ? '—' : formatNumber(v));

  return (
    <>
      <div className="panel">
        <h2>🎯 Executive summary</h2>
        {/*
          Scope stated up front and read from the data rather than typed. The
          reference design was headed "2025 / annual spend" over a part-year
          extract of a single entity; a reader who trusts that headline draws
          conclusions about a population that was never measured.
        */}
        <p className="note">
          <span className="bs sl">scope</span>{' '}
          Committed value on purchase orders
          {firstDate && asOfDate ? <> from <strong>{firstDate}</strong> to <strong>{asOfDate}</strong></> : null}
          . Stock-transport and deleted lines are excluded throughout, so every figure on
          this page counts the same population. Values are <strong>ordered</strong> — this
          is commitment, not invoiced or received cash.
        </p>
        {err && <p className="note"><span className="bs spdel">error</span> {err}</p>}

        <div className="kpi-grid">
          {tiles.map((t) => (
            <button
              key={t.label}
              type="button"
              className="xs-tile"
              disabled={!t.kpi?.drillToken}
              onClick={() => t.kpi?.drillToken && onDrill(t.kpi.drillToken, t.kpi.title)}
              title={t.kpi?.drillToken ? 'Click to open the underlying lines' : undefined}
            >
              <span className="xs-tile-value">{t.value}</span>
              <span className="xs-tile-label">{t.label}</span>
              <span className="xs-tile-sub muted">{t.sub}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="panel">
        <h3 className="pr-tbl-h">
          Where the value is <span className="muted">— committed value by spend category</span>
        </h3>
        {byCategory
          ? <RankedBars data={byCategory} onDrill={onDrill} emphasiseTop={5} />
          : <div className="spinner" />}
        <p className="note" style={{ marginTop: '.5rem' }}>
          The <strong>top five</strong> categories are shaded; together they are{' '}
          <strong>{pct(top5)}</strong> of committed value. Categories resolve from the
          business mapping first, then SAP&apos;s material master.{' '}
          <code>(no material code)</code> is shown as itself rather than folded into a
          category — it is service and text lines, and burying it would misstate every
          share above it.
        </p>
      </div>

      <div className="panel">
        <h3 className="pr-tbl-h">
          Transaction size <span className="muted">— share of value against share of lines</span>
        </h3>
        {byBand ? <BandPairs data={byBand} onDrill={onDrill} /> : <div className="spinner" />}
        <p className="note" style={{ marginTop: '.5rem' }}>
          Bands are ordered by size, never by measure. Lines with no rupiah value are
          excluded rather than counted as zero, which would inflate the smallest band —
          the band the whole fragmentation argument rests on.
        </p>
      </div>

      <div className="panel">
        <h3 className="pr-tbl-h">
          How concentrated <span className="muted">— how few hold most of the value</span>
        </h3>
        <div className="table-wrap">
          <table className="data dd-tbl">
            <tbody>
              <tr className="re">
                <td>Purchasing desks</td>
                <td>
                  <strong>{n(desks80)}</strong> of {n(desksAll)} desks hold 80% of committed value
                </td>
              </tr>
              <tr>
                <td>Vendors</td>
                <td>
                  <strong>{n(vend80)}</strong> of {n(vendAll)} vendors hold 80% of committed value
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="note" style={{ marginTop: '.5rem' }}>
          This replaces a Head-Office-versus-site split. That split cannot be measured on
          this data: no Head-Office purchasing group appears in these orders at all, so it
          computes to 2% against 98% and would state the opposite of the truth. Desk and
          vendor concentration makes the same point from what is actually here.
        </p>
      </div>

      {/*
        The conclusion, assembled from the KPIs above rather than written out. In
        the reference design this was static prose ("top 5 = 70%", "72% of lines
        < Rp 25 Jt = 4% of value") — correct on the day it was drawn and wrong
        from the next refresh onwards.
      */}
      <div className="panel">
        <h3 className="pr-tbl-h">What this means</h3>
        <ul className="xs-means">
          <li>
            <strong>Value is concentrated.</strong> The top five categories are {pct(top5)} of
            committed value, and {n(desks80)} desks hold 80% of it.
          </li>
          <li>
            <strong>Work is fragmented.</strong> {pct(linesTail)} of PO lines are under
            Rp 25 Jt and carry {pct(valueTail)} of the value — most of the effort buys
            almost none of the spend.
          </li>
          <li>
            <strong>The two do not overlap.</strong> Price belongs on the few large
            commodities; the many small lines are a process problem, not a negotiation
            one, and no sourcing effort spent on them moves the total.
          </li>
        </ul>
      </div>
    </>
  );
}
