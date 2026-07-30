/**
 * Cell coercion — Annex A §A.9.
 *
 * Written out explicitly rather than inherited from a parser's implicit
 * behaviour. These rules are the difference between 22% of goods receipts being
 * counted and being silently zeroed, so they are unit-tested exhaustively.
 *
 * Invariant across this whole file: a blank or unparseable input returns null,
 * NEVER 0. Zero is a real measured value with meaning (STO prices are 0).
 */

/**
 * SAP numeric: thousands separators, trailing minus, European decimal comma.
 * Returns null for blank/unparseable — never 0.
 */
export function parseVal(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'boolean') return null;

  let s = String(raw).trim();
  if (s === '') return null;

  let negative = false;
  if (s.endsWith('-')) {
    // SAP trailing minus: "1.234,56-"
    negative = true;
    s = s.slice(0, -1).trim();
  } else if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1).trim();
  } else if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1).trim();
  }

  s = s.replace(/\s/g, '');
  if (s === '') return null;

  // European "1.234.567,89" vs Anglo "1,234,567.89"
  if (/,\d{1,2}$/.test(s) && s.includes('.')) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/,\d{1,2}$/.test(s) && !s.includes('.')) {
    s = s.replace(',', '.');
  } else {
    s = s.replace(/,/g, '');
  }

  if (!/^\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/**
 * Document numbers stay strings: leading zeros and length are significant.
 */
export function parseDocNo(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}

/**
 * Integer item numbers. Blank and '0' both yield null where '0' is a sentinel;
 * callers that need to distinguish use parseIntStrict.
 */
export function parseIntStrict(raw: unknown): number | null {
  const s = parseDocNo(raw);
  if (s === null) return null;
  const n = Number(s);
  return Number.isInteger(n) ? n : null;
}

/**
 * PO Report `Item of requisition` uses '0' as the NULL sentinel — 9,094 rows in
 * the reference export, exactly matching the blank `Purchase Requisition` count.
 * Without this, every direct PO joins to a phantom requisition item 0.
 */
export function parseReqItem(raw: unknown): number | null {
  const n = parseIntStrict(raw);
  if (n === null || n <= 0) return null;
  return n;
}

function toIsoDate(y: number, mo: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(mo) || !Number.isInteger(d)) return null;
  if (y < 1900 || y > 2200) return null;
  if (mo < 1 || mo > 12) return null;
  if (d < 1 || d > 31) return null;
  // Reject impossible calendar dates (31 Feb etc.)
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Dates: Excel serial, ISO, dd.MM.yyyy, dd/MM/yyyy.
 *
 * Returns a plain calendar date string (yyyy-mm-dd). NO timezone conversion is
 * applied anywhere: a posting date is a calendar date, and shifting it by a
 * timezone offset silently moves documents between months.
 *
 * NOTE dd/MM/yyyy is ambiguous. We assume day-first, matching the SAP export
 * locale. Prefer ISO or dd.MM.yyyy at source.
 */
export function parseDate(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;

  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    // Excel/SheetJS dates arrive as UTC midnight; read the UTC components so no
    // local-timezone shift is introduced.
    return toIsoDate(raw.getUTCFullYear(), raw.getUTCMonth() + 1, raw.getUTCDate());
  }

  if (typeof raw === 'number') {
    // Excel serial, 1900 date system.
    //
    // Serials 1-60 fall in the region distorted by Excel's phantom 1900-02-29,
    // so any value there is ambiguous by a day. SAP procurement dates are never
    // in 1900, so we reject that range rather than return a silently wrong date.
    if (!Number.isFinite(raw) || raw < 61 || raw > 2958465) return null;
    const ms = Math.round((raw - 25569) * 86400000);
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return null;
    return toIsoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }

  const s = String(raw).trim();
  if (s === '') return null;

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return toIsoDate(+m[1]!, +m[2]!, +m[3]!);

  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  if (m) return toIsoDate(+m[3]!, +m[2]!, +m[1]!);

  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return toIsoDate(+m[3]!, +m[2]!, +m[1]!);

  return null;
}

/** HH:MM:SS from a string or an Excel time fraction. */
export function parseTime(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    return [raw.getUTCHours(), raw.getUTCMinutes(), raw.getUTCSeconds()]
      .map((n) => String(n).padStart(2, '0'))
      .join(':');
  }
  if (typeof raw === 'number' && raw >= 0 && raw < 1) {
    const total = Math.round(raw * 86400);
    const h = Math.floor(total / 3600);
    const mi = Math.floor((total % 3600) / 60);
    const se = total % 60;
    return [h, mi, se].map((n) => String(n).padStart(2, '0')).join(':');
  }
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(raw).trim());
  if (!m) return null;
  const h = +m[1]!;
  const mi = +m[2]!;
  const se = m[3] ? +m[3] : 0;
  if (h > 23 || mi > 59 || se > 59) return null;
  return [h, mi, se].map((n) => String(n).padStart(2, '0')).join(':');
}

/**
 * Currency normalisation. The reference PO export carries BOTH `US$` (328 lines)
 * and `USD` (4 lines); the rate file uses `US$`. Normalisation is mandatory,
 * not cosmetic.
 */
export function normCurrency(raw: unknown): string | null {
  const s = String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
  if (s === '') return null;
  if (s === 'US$' || s === 'USD$' || s === '$') return 'USD';
  return s;
}

/** Header normalisation for signature matching and alias healing. */
export function normHeader(raw: unknown): string {
  return String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * PR Report `Deletion indicator` is the literal string 'true'/'false'.
 * PO Report `Deletion indicator` is 'L' or blank — handled separately in status.
 */
export function parseBoolString(raw: unknown): boolean | null {
  if (typeof raw === 'boolean') return raw;
  const s = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (s === '') return null;
  if (s === 'true' || s === 'x' || s === 'yes' || s === '1') return true;
  if (s === 'false' || s === 'no' || s === '0') return false;
  return null;
}

/** Trim to null. Used for every descriptive string field. */
export function parseStr(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  return s === '' ? null : s;
}

/**
 * PO Report `Supplier/Supplying Plant` is "CODE  NAME" (code, whitespace, name).
 * For an STO the "supplier" is the supplying plant, so the code may be a plant.
 */
export function splitSupplier(raw: unknown): { code: string | null; name: string | null } {
  const s = parseStr(raw);
  if (s === null) return { code: null, name: null };
  const m = /^(\S+)\s{2,}(.+)$/.exec(s);
  if (m) return { code: m[1]!.trim(), name: m[2]!.trim() };

  // Single-space form. Only split when the first token looks like an SAP code:
  // a vendor code (LN12000179) or, for an STO, a supplying plant (EU73).
  const m2 = /^(\S+)\s+(.+)$/.exec(s);
  if (m2 && /^[A-Z]{2}\d{2,}$/i.test(m2[1]!)) return { code: m2[1]!.trim(), name: m2[2]!.trim() };
  return { code: null, name: s };
}
