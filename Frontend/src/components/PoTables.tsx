import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { formatMoney, formatNumber } from '../lib/format';
import { MaterialModal, VendorModal } from './EntityViews';

/**
 * v1's PO-page top-spend tables (replacing the bar charts, 4 Aug 2026):
 * top vendors and top materials by spend, with totals, opening the
 * Vendor-360 / Material-360 popups on click.
 */

interface VendorRow {
  vendorCode: string; vendorName: string | null; poCount: number; lineCount: number;
  spendUsd: number | null; materials: number; areas: number;
}
interface MaterialRow {
  materialCode: string; description: string | null; lines: number; qty: number | null;
  spendUsd: number | null; spendIdr: number | null; lastPo: string | null;
}

export function PoTables({ onDrill }: { onDrill: (token: string, label: string) => void }) {
  const [vendors, setVendors] = useState<VendorRow[] | null>(null);
  const [materials, setMaterials] = useState<MaterialRow[] | null>(null);
  const [materialsTotal, setMaterialsTotal] = useState<number | null>(null);
  const [openVendor, setOpenVendor] = useState<string | null>(null);
  const [openMaterial, setOpenMaterial] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.get<{ rows: VendorRow[] }>('/api/v1/entity/top-vendors-spend?limit=10')
      .then((d) => { if (!cancelled) setVendors(d.rows); })
      .catch(() => { if (!cancelled) setVendors([]); });
    api.get<{ rows: MaterialRow[]; totalUsd: number | null }>('/api/v1/entity/top-materials-spend?limit=10')
      .then((d) => { if (!cancelled) { setMaterials(d.rows); setMaterialsTotal(d.totalUsd); } })
      .catch(() => { if (!cancelled) setMaterials([]); });
    return () => { cancelled = true; };
  }, []);

  const vendorSum = (vendors ?? []).reduce((a, v) => a + (v.spendUsd ?? 0), 0);
  const materialSum = (materials ?? []).reduce((a, m) => a + (m.spendUsd ?? 0), 0);

  return (
    <>
      <div className="chart-grid" style={{ marginTop: '1rem' }}>
        <div className="panel">
          <h3 className="pr-tbl-h">Top vendors by spend — click a row for Vendor 360</h3>
          <div className="table-wrap" style={{ maxHeight: 340, overflowY: 'auto' }}>
            <table className="data dd-tbl">
              <thead>
                <tr>
                  <th>Vendor</th>
                  <th className="num"># POs</th>
                  <th className="num">Lines</th>
                  <th className="num">Materials</th>
                  <th className="num">Spend (USD)</th>
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
                    <td className="num">{v.spendUsd === null ? '—' : formatMoney(v.spendUsd, 'USD')}</td>
                  </tr>
                ))}
              </tbody>
              {vendors !== null && vendors.length > 0 && (
                <tfoot>
                  <tr className="po-tbl-total">
                    <td colSpan={4}>Σ top {vendors.length} vendors</td>
                    <td className="num">{formatMoney(vendorSum, 'USD')}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>

        <div className="panel">
          <h3 className="pr-tbl-h">Top materials by spend — click a row for Material 360</h3>
          <div className="table-wrap" style={{ maxHeight: 340, overflowY: 'auto' }}>
            <table className="data dd-tbl">
              <thead>
                <tr>
                  <th>Material</th>
                  <th>Description</th>
                  <th className="num">Lines</th>
                  <th className="num">Spend (USD)</th>
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
                    <td className="num">{m.spendUsd === null ? '—' : formatMoney(m.spendUsd, 'USD')}</td>
                    <td>{m.lastPo ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
              {materials !== null && materials.length > 0 && (
                <tfoot>
                  <tr className="po-tbl-total">
                    <td colSpan={3}>Σ top {materials.length} materials</td>
                    <td className="num">{formatMoney(materialSum, 'USD')}</td>
                    <td className="muted">{materialsTotal !== null ? `of ${formatMoney(materialsTotal, 'USD')} total` : ''}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      </div>

      {openVendor && <VendorModal code={openVendor} onClose={() => setOpenVendor(null)} onDrill={onDrill} />}
      {openMaterial && <MaterialModal code={openMaterial} onClose={() => setOpenMaterial(null)} onDrill={onDrill} />}
    </>
  );
}
