import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { formatMoney, formatNumber } from '../lib/format';

/**
 * v1's PR Analysis tables (pr-bneck / pr-reqr): approval bottlenecks per
 * release PIC and top-10 demand by requisitioner. Row clicks open the same
 * server-verified drills as every other figure.
 */

interface BneckRow {
  pic: string; codes: string; avgGap: number | null; medGap: number | null;
  steps: number; pending: number; drillPending: string;
}
interface ReqRow {
  requisitioner: string; items: number; valueIdr: number | null; valueUsd: number | null;
  emg: number; urg: number; drill: string;
}

export function PrTables({ onDrill }: { onDrill: (token: string, label: string) => void }) {
  const [bneck, setBneck] = useState<BneckRow[] | null>(null);
  const [reqr, setReqr] = useState<ReqRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.get<{ rows: BneckRow[] }>('/api/v1/entity/approver-bottlenecks')
      .then((d) => { if (!cancelled) setBneck(d.rows); })
      .catch(() => { if (!cancelled) setBneck([]); });
    api.get<{ rows: ReqRow[] }>('/api/v1/entity/requisitioner-demand')
      .then((d) => { if (!cancelled) setReqr(d.rows); })
      .catch(() => { if (!cancelled) setReqr([]); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="chart-grid" style={{ marginTop: '1rem' }}>
      <div className="panel">
        <h3 className="pr-tbl-h">Approval Bottlenecks — avg gap per approver (PR Release)</h3>
        <div className="table-wrap" style={{ maxHeight: 300, overflowY: 'auto' }}>
          <table className="data dd-tbl">
            <thead>
              <tr>
                <th>Approver (PIC)</th>
                <th>Rel Codes</th>
                <th className="num">Avg Gap (d)</th>
                <th className="num">Median (d)</th>
                <th className="num">Steps</th>
                <th className="num">Pending</th>
              </tr>
            </thead>
            <tbody>
              {bneck === null && (
                <tr><td colSpan={6} className="muted">Loading…</td></tr>
              )}
              {bneck !== null && bneck.length === 0 && (
                <tr><td colSpan={6} className="muted">No approval-step data (needs GAP Approval Lead Time in PR Release export).</td></tr>
              )}
              {(bneck ?? []).map((b, i) => (
                <tr
                  key={b.pic}
                  className={i % 2 ? '' : 're'}
                  style={{ cursor: 'pointer' }}
                  title="Click for this approver's pending release steps"
                  onClick={() => onDrill(b.drillPending, `Pending PR approval · ${b.pic}`)}
                >
                  <td>{b.pic}</td>
                  <td>{b.codes}</td>
                  <td className="num" style={b.avgGap !== null && b.avgGap > 7 ? { color: 'var(--crit)', fontWeight: 700 } : { fontWeight: 700 }}>
                    {b.avgGap === null ? '—' : b.avgGap.toFixed(1)}
                  </td>
                  <td className="num">{b.medGap === null ? '—' : b.medGap.toFixed(1)}</td>
                  <td className="num">{formatNumber(b.steps)}</td>
                  <td className="num" style={b.pending ? { color: 'var(--warn)', fontWeight: 700 } : undefined}>
                    {b.pending}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h3 className="pr-tbl-h">Demand by Requisitioner — top 10 by value</h3>
        <div className="table-wrap" style={{ maxHeight: 300, overflowY: 'auto' }}>
          <table className="data dd-tbl">
            <thead>
              <tr>
                <th>Requisitioner</th>
                <th className="num">PR Items</th>
                <th className="num">Value</th>
                <th className="num" title="Share of PR items with urgency 1 (01-Emergency)">Emg %</th>
                <th className="num" title="Share of PR items with urgency 2 (02-Urgent)">Urg %</th>
              </tr>
            </thead>
            <tbody>
              {reqr === null && (
                <tr><td colSpan={5} className="muted">Loading…</td></tr>
              )}
              {reqr !== null && reqr.length === 0 && (
                <tr><td colSpan={5} className="muted">No requisitioner data.</td></tr>
              )}
              {(reqr ?? []).map((q, i) => {
                const emgPct = q.items ? (q.emg / q.items) * 100 : 0;
                const urgPct = q.items ? (q.urg / q.items) * 100 : 0;
                return (
                  <tr
                    key={q.requisitioner}
                    className={i % 2 ? '' : 're'}
                    style={{ cursor: 'pointer' }}
                    title="Show this requisitioner's PR lines"
                    onClick={() => onDrill(q.drill, `Requisitioner: ${q.requisitioner}`)}
                  >
                    <td>{q.requisitioner}</td>
                    <td className="num">{formatNumber(q.items)}</td>
                    <td className="num">
                      {q.valueUsd !== null ? formatMoney(q.valueUsd, 'USD') : formatMoney(q.valueIdr, 'IDR')}
                    </td>
                    <td className="num" style={emgPct > 30 ? { color: 'var(--crit)', fontWeight: 700 } : undefined}>
                      {emgPct.toFixed(0)}%
                    </td>
                    <td className="num" style={urgPct > 50 ? { color: 'var(--orange)', fontWeight: 700 } : undefined}>
                      {urgPct.toFixed(0)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
