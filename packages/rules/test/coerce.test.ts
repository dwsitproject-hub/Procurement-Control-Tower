import { describe, it, expect } from 'vitest';
import {
  parseVal,
  parseDate,
  parseTime,
  parseReqItem,
  parseIntStrict,
  normCurrency,
  normHeader,
  parseBoolString,
  splitSupplier,
  parseDocNo,
} from '../src/coerce.js';

describe('parseVal', () => {
  it('returns null for blank, never 0', () => {
    // The single most important property in this file: a blank measure must not
    // become a zero, because zero is a real value (STO prices are 0).
    expect(parseVal('')).toBeNull();
    expect(parseVal('   ')).toBeNull();
    expect(parseVal(null)).toBeNull();
    expect(parseVal(undefined)).toBeNull();
  });

  it('preserves a genuine zero', () => {
    expect(parseVal(0)).toBe(0);
    expect(parseVal('0')).toBe(0);
  });

  it('handles SAP trailing minus', () => {
    expect(parseVal('1234.56-')).toBe(-1234.56);
    expect(parseVal('5000264-')).toBe(-5000264);
  });

  it('handles leading minus and parentheses', () => {
    expect(parseVal('-42')).toBe(-42);
    expect(parseVal('(42)')).toBe(-42);
  });

  it('strips Anglo thousands separators', () => {
    expect(parseVal('1,234,567.89')).toBeCloseTo(1234567.89, 6);
    expect(parseVal('198,640,596')).toBe(198640596);
  });

  it('handles European decimal comma', () => {
    expect(parseVal('1.234.567,89')).toBeCloseTo(1234567.89, 6);
    expect(parseVal('3250000,50')).toBeCloseTo(3250000.5, 6);
  });

  it('passes through numbers', () => {
    expect(parseVal(17982.1)).toBe(17982.1);
    expect(parseVal(Number.NaN)).toBeNull();
    expect(parseVal(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('rejects non-numeric text', () => {
    expect(parseVal('n/a')).toBeNull();
    expect(parseVal('EU70')).toBeNull();
    expect(parseVal(true)).toBeNull();
  });

  it('parses real reference values', () => {
    expect(parseVal('17982.100000')).toBeCloseTo(17982.1, 6);
    expect(parseVal('0.0000556108')).toBeCloseTo(0.0000556108, 12);
  });
});

describe('parseReqItem — the "0" null sentinel', () => {
  it("treats '0' as null (9,094 rows in the reference export)", () => {
    // Without this, every direct PO joins to a phantom requisition item 0.
    expect(parseReqItem('0')).toBeNull();
    expect(parseReqItem(0)).toBeNull();
  });

  it('accepts real item numbers', () => {
    expect(parseReqItem('1')).toBe(1);
    expect(parseReqItem('12')).toBe(12);
    expect(parseReqItem(48)).toBe(48);
  });

  it('rejects blanks and negatives', () => {
    expect(parseReqItem('')).toBeNull();
    expect(parseReqItem(null)).toBeNull();
    expect(parseReqItem('-1')).toBeNull();
  });

  it('differs from parseIntStrict, which keeps 0', () => {
    expect(parseIntStrict('0')).toBe(0);
    expect(parseReqItem('0')).toBeNull();
  });
});

describe('parseDate', () => {
  it('parses ISO', () => {
    expect(parseDate('2026-07-27')).toBe('2026-07-27');
    expect(parseDate('2026-07-27 00:00:00')).toBe('2026-07-27');
  });

  it('parses dd.MM.yyyy', () => {
    expect(parseDate('14.01.2026')).toBe('2026-01-14');
    expect(parseDate('1.1.2026')).toBe('2026-01-01');
  });

  it('parses dd/MM/yyyy day-first', () => {
    expect(parseDate('05/03/2026')).toBe('2026-03-05');
  });

  it('parses Date objects without timezone shift', () => {
    // A posting date is a calendar date. Reading local components would move
    // documents between months for users east or west of UTC.
    expect(parseDate(new Date(Date.UTC(2026, 6, 27)))).toBe('2026-07-27');
    expect(parseDate(new Date(Date.UTC(2025, 11, 31)))).toBe('2025-12-31');
  });

  it('parses Excel serials', () => {
    expect(parseDate(46230)).toBe('2026-07-27');
    expect(parseDate(46023)).toBe('2026-01-01');
  });

  it('rejects Excel serials in the 1900 leap-bug region as ambiguous', () => {
    // Serials 1-60 are distorted by Excel's phantom 1900-02-29. SAP procurement
    // dates are never in 1900, so a silently wrong date is worse than a null.
    expect(parseDate(1)).toBeNull();
    expect(parseDate(60)).toBeNull();
    expect(parseDate(61)).not.toBeNull();
  });

  it('rejects impossible calendar dates', () => {
    expect(parseDate('31.02.2026')).toBeNull();
    expect(parseDate('2026-13-01')).toBeNull();
    expect(parseDate('2026-00-10')).toBeNull();
  });

  it('returns null for blank and junk', () => {
    expect(parseDate('')).toBeNull();
    expect(parseDate(null)).toBeNull();
    expect(parseDate('not a date')).toBeNull();
    expect(parseDate(0)).toBeNull();
  });
});

describe('parseTime', () => {
  it('parses HH:MM:SS', () => {
    expect(parseTime('08:50:55')).toBe('08:50:55');
    expect(parseTime('22:34:39')).toBe('22:34:39');
    expect(parseTime('9:05')).toBe('09:05:00');
  });

  it('parses Excel time fractions', () => {
    expect(parseTime(0.5)).toBe('12:00:00');
  });

  it('rejects invalid times', () => {
    expect(parseTime('25:00:00')).toBeNull();
    expect(parseTime('')).toBeNull();
  });
});

describe('normCurrency', () => {
  it('normalises US$ to USD', () => {
    // The reference PO export carries BOTH spellings: US$ (328 lines) and
    // USD (4 lines). The rate file uses US$.
    expect(normCurrency('US$')).toBe('USD');
    expect(normCurrency('us$')).toBe('USD');
    expect(normCurrency(' US$ ')).toBe('USD');
    expect(normCurrency('USD')).toBe('USD');
  });

  it('uppercases and trims other currencies', () => {
    expect(normCurrency('idr')).toBe('IDR');
    expect(normCurrency(' CNY ')).toBe('CNY');
  });

  it('returns null for blank', () => {
    expect(normCurrency('')).toBeNull();
    expect(normCurrency(null)).toBeNull();
  });
});

describe('normHeader', () => {
  it('collapses SAP header punctuation', () => {
    expect(normHeader('Deliv. date(From/to)')).toBe('delivdatefromto');
    expect(normHeader('Still to be invoiced (val.)')).toBe('stilltobeinvoicedval');
    expect(normHeader('Purch. organization')).toBe('purchorganization');
    expect(normHeader('Amt.in Loc.Cur.')).toBe('amtinloccur');
    expect(normHeader('Σ Net Order Value')).toBe('netordervalue');
  });
});

describe('parseBoolString', () => {
  it("handles the literal 'true'/'false' strings in PR Report", () => {
    expect(parseBoolString('true')).toBe(true);
    expect(parseBoolString('false')).toBe(false);
    expect(parseBoolString('TRUE')).toBe(true);
  });

  it('handles X as true', () => {
    expect(parseBoolString('X')).toBe(true);
  });

  it('returns null for blank', () => {
    expect(parseBoolString('')).toBeNull();
    expect(parseBoolString(null)).toBeNull();
  });
});

describe('splitSupplier', () => {
  it('splits code and name on double space', () => {
    expect(splitSupplier('LN12000179 MAXIMA LINERS PT.')).toEqual({
      code: 'LN12000179',
      name: 'MAXIMA LINERS PT.',
    });
  });

  it('handles a supplying plant for STO lines', () => {
    expect(splitSupplier('EU73 EUP GENERAL TJ.PURA')).toEqual({
      code: 'EU73',
      name: 'EUP GENERAL TJ.PURA',
    });
  });

  it('returns name-only when there is no code', () => {
    expect(splitSupplier('SCASH      LJM WATER').code).toBe('SCASH');
    expect(splitSupplier('')).toEqual({ code: null, name: null });
  });
});

describe('parseDocNo', () => {
  it('keeps document numbers as strings so leading zeros survive', () => {
    expect(parseDocNo('1002119623')).toBe('1002119623');
    expect(parseDocNo('0000123')).toBe('0000123');
    expect(parseDocNo(1002119623)).toBe('1002119623');
  });
});

describe('date parsing is timezone-independent (regression)', () => {
  // Regression guard for a real defect: with SheetJS cellDates enabled, date
  // cells arrive as Dates built in LOCAL time, so on a UTC+7 host every date
  // shifted back one day. Day differences survived, so aging looked correct
  // while absolute dates were wrong and documents crossed month boundaries.
  // Serial-number parsing uses pure UTC arithmetic and cannot drift.
  it('converts Excel serials identically regardless of host timezone', () => {
    const original = process.env.TZ;
    const results: string[] = [];
    for (const tz of ['UTC', 'Asia/Jakarta', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
      process.env.TZ = tz;
      results.push(parseDate(46230)!, parseDate(46023)!);
    }
    process.env.TZ = original;
    expect(new Set(results.filter((_, i) => i % 2 === 0)).size).toBe(1);
    expect(results[0]).toBe('2026-07-27');
    expect(results[1]).toBe('2026-01-01');
  });

  it('parses the boundary dates of the reference export', () => {
    // 1 Jan must not land in December, and 27 Jul must not land on the 26th.
    expect(parseDate(46023)).toBe('2026-01-01');
    expect(parseDate(46230)).toBe('2026-07-27');
    expect(parseDate('2026-01-01')).toBe('2026-01-01');
    expect(parseDate('2026-07-27')).toBe('2026-07-27');
  });
});
