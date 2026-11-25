/**
 * Vendor Type: Local or Import, from the SAP vendor code prefix.
 *
 * Local = `LN…`, Import = `IN…`. Settled with the user on 19 Nov 2026: the
 * request said the opposite, but the vendors say otherwise - the LN codes are
 * Indonesian PT/CV companies (1,147 vendors), the IN codes Chinese, Malaysian
 * and other foreign suppliers (238). Every other prefix - the group's own plants
 * acting as vendors (EU…, SC…, PM…), one-time cash vendors (SCASH) - is
 * neither, and drops out of both.
 *
 * ONE definition, used by every filter, card split and drill, so a Local figure
 * on one page and the rows behind it can never be classified two ways.
 */

export type VendorType = 'local' | 'import';

export const VENDOR_TYPE_PREFIX: Record<VendorType, string> = { local: 'LN', import: 'IN' };
export const VENDOR_TYPE_LABEL: Record<VendorType, string> = { local: 'Local', import: 'Import' };

/** 'local' | 'import' from a query value ('Local', 'import', ...), else null. */
export function parseVendorType(v: unknown): VendorType | null {
  const s = String(v ?? '').trim().toLowerCase();
  return s === 'local' || s === 'import' ? s : null;
}

/** `<col> LIKE 'LN%'` - the SQL predicate for one type. No user input reaches it. */
export function vendorTypePredicate(col: string, vt: VendorType): string {
  return `${col} LIKE '${VENDOR_TYPE_PREFIX[vt]}%'`;
}

/** 'local' / 'import' / NULL for a vendor-code column, as SQL. */
export function vendorTypeSql(col: string): string {
  return `CASE WHEN ${vendorTypePredicate(col, 'local')} THEN 'local'
               WHEN ${vendorTypePredicate(col, 'import')} THEN 'import' END`;
}

/** The same rule in TypeScript, for rows already fetched. */
export function vendorTypeOf(code: string | null | undefined): VendorType | null {
  const c = (code ?? '').trim().toUpperCase();
  if (c.startsWith(VENDOR_TYPE_PREFIX.local)) return 'local';
  if (c.startsWith(VENDOR_TYPE_PREFIX.import)) return 'import';
  return null;
}
