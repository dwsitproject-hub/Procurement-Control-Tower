import { Suspense, lazy, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { formatCurrency, formatMoney, formatNumber } from '../lib/format';
import { Lbl } from '../lib/labels';
/**
 * The Vendor/Material 360 popups are loaded on demand. They live in
 * EntityViews alongside the two full pages, so importing them statically here
 * pulled that entire module — both pages included — into the main bundle for
 * everyone, even though a popup only appears once someone clicks a row.
 */
const VendorModal = lazy(() => import('./EntityViews').then((m) => ({ default: m.VendorModal })));
const MaterialModal = lazy(() => import('./EntityViews').then((m) => ({ default: m.MaterialModal })));

/**
 * v1's PO-page top-spend tables (replacing the bar charts, 4 Aug 2026):
 * top vendors and top materials by spend, with totals, opening the
 * Vendor-360 / Material-360 popups on click.
 */

interface VendorRow {
  vendorCode: string; vendorName: string | null; poCount: number; lineCount: number;
  spendUsd: number | null; spendIdr: number | null; materials: number; areas: number;
}
interface MaterialRow {
  materialCode: string; description: string | null; lines: number; qty: number | null;
  spendUsd: number | null; spendIdr: number | null; lastPo: string | null;
}

export function PoTables({ onDrill, currency = 'USD' }: {
  onDrill: (token: string, label: string) => void;
  /** Topbar display currency. */
  currency?: 'USD' | 'IDR';
}) {
  const [vendors, setVendors] = useState<VendorRow[] | null>(null);
  const [materials, setMaterials] = useState<MaterialRow[] | null>(null);
  const [materialsTotal, setMaterialsTotal] = useState<number | null>(null);
  const [materialsTotalIdr, setMaterialsTotalIdr] = useState<number | null>(null);
  const [openVendor, setOpenVendor] = useState<string | null>(null);
  const [openMaterial, setOpenMaterial] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.get<{ rows: VendorRow[] }>('/api/v1/entity/top-vendors-spend?limit=10')
      .then((d) => { if (!cancelled) setVendors(d.rows); })
      .catch(() => { if (!cancelled) setVendors([]); });
    api.get<{ rows: MaterialRow[]; totalUsd: number | null; totalIdr: number | null }>('/api/v1/entity/top-materials-spend?limit=10')
      .then((d) => {
        if (!cancelled) { setMaterials(d.rows); setMaterialsTotal(d.totalUsd); setMaterialsTotalIdr(d.totalIdr); }
      })
      .catch(() => { if (!cancelled) setMaterials([]); });
    return () => { cancelled = true; };
  }, []);

  const pick = (usd: number | null, idr: number | null) => (currency === 'IDR' ? idr : usd) ?? 0;
  const vendorSum = (vendors ?? []).reduce((a, v) => a + pick(v.spendUsd, v.spendIdr), 0);
  const materialSum = (materials ?? []).reduce((a, m) => a + pick(m.spendUsd, m.spendIdr), 0);

  return (
    <>
      <div className="chart-grid" style={{ marginTop: '1rem' }}>
        <div className="panel">
          <h3 className="pr-tbl-h"><Lbl>Top vendors by spend — click a row for Vendor 360</Lbl></h3>
          <div className="table-wrap" style={{ maxHeight: 340, overflowY: 'auto' }}>
            <table className="data dd-tbl">
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th className="num"># POs</th>
                  <th className="num">Lines</th>
                  <th className="num">Materials</th>
                  <th className="num">Spend ({currency})</th>
                </tr>
              </thead>
              <tbody>
                {vendors === null && <tr><td colSpan={5} className="muted">Loading…</td></tr>}
                {vendors !== null && vendors.length === 0 && <tr><td colSpan={5} className="muted">No vendor spend data.</td></tr>}
                {(vendors ?? []).map((v, i) => (
                  <tr
                    key={v.vendorCode}
                    className={i % 2 ? '' : 're'}
                    style={{ cursor: 'pointer' }}
                    title="Open Vendor 360"
                    onClick={() => setOpenVendor(v.vendorCode)}
                  >
                    <td>{v.vendorName ?? v.vendorCode}</td>
                    <td className="num">{formatNumber(v.poCount)}</td>
                    <td className="num">{formatNumber(v.lineCount)}</td>
                    <td className="num">{formatNumber(v.materials)}</td>
                    <td className="num">{formatCurrency(v.spendUsd, v.spendIdr, currency)}</td>
                  </tr>
                ))}
              </tbody>
              {vendors !== null && vendors.length > 0 && (
                <tfoot>
                  <tr className="po-tbl-total">
                    <td colSpan={4}>Σ top {vendors.length} vendors</td>
                    <td className="num">{formatMoney(vendorSum, currency)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>

        <div className="panel">
          <h3 className="pr-tbl-h"><Lbl>Top materials by spend — click a row for Material 360</Lbl></h3>
          <div className="table-wrap" style={{ maxHeight: 340, overflowY: 'auto' }}>
            <table className="data dd-tbl">
              <thead>
                <tr>
                  <th>Material</th>
                  <th>Description</th>
                  <th className="num">Lines</th>
                  <th className="num">Spend ({currency})</th>
                  <th>Last PO</th>
                </tr>
              </thead>
              <tbody>
                {materials === null && <tr><td colSpan={5} className="muted">Loading…</td></tr>}
                {materials !== null && materials.length === 0 && <tr><td colSpan={5} className="muted">No material spend data.</td></tr>}
                {(materials ?? []).map((m, i) => (
                  <tr
                    key={m.materialCode}
                    className={i % 2 ? '' : 're'}
                    style={{ cursor: 'pointer' }}
                    title="Open Material 360"
                    onClick={() => setOpenMaterial(m.materialCode)}
                  >
                    <td>{m.materialCode}</td>
                    <td>{m.description ?? '—'}</td>
                    <td className="num">{formatNumber(m.lines)}</td>
                    <td className="num">{formatCurrency(m.spendUsd, m.spendIdr, currency)}</td>
                    <td>{m.lastPo ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
              {materials !== null && materials.length > 0 && (
                <tfoot>
                  <tr className="po-tbl-total">
                    <td colSpan={3}>Σ top {materials.length} materials</td>
                    <td className="num">{formatMoney(materialSum, currency)}</td>
                    <td className="muted">{(() => {
                      const t = currency === 'IDR' ? materialsTotalIdr : materialsTotal;
                      return t !== null ? `of ${formatMoney(t, currency)} total` : '';
                    })()}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      </div>

      <Suspense fallback={null}>
        {openVendor && <VendorModal code={openVendor} onClose={() => setOpenVendor(null)} onDrill={onDrill} />}
        {openMaterial && <MaterialModal code={openMaterial} onClose={() => setOpenMaterial(null)} onDrill={onDrill} />}
      </Suspense>
    </>
  );
}
