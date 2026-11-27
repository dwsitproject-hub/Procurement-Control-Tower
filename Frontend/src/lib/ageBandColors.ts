/**
 * The colour of each outstanding-PR age band, shared by every chart that
 * stacks requisitions by how long they have waited (27 Nov 2026): the
 * Executive Summary's "Outstanding PR by Days/Months/Quarters/Years" and the
 * requisition flow chart ("PR Inflow vs PR Outflow") use the same colour for
 * the same band. Green for the newest, through amber, to dark red for the
 * oldest. Keys are @pct/rules' AGE_BANDS keys.
 */
export const AGE_BAND_COLORS: Record<string, string> = {
  '<7': '#4CAF50',
  '8-30': '#a3c93a',
  '31-60': '#d4b106',
  '61-90': '#ea7317',
  '91-150': '#dc2626',
  '>150': '#7f1d1d',
};

/** The bands youngest first, with the labels the charts print. */
export const AGE_BAND_ORDER: { key: string; label: string }[] = [
  { key: '<7', label: '< 7 d' },
  { key: '8-30', label: '8-30 d' },
  { key: '31-60', label: '31-60 d' },
  { key: '61-90', label: '61-90 d' },
  { key: '91-150', label: '91-150 d' },
  { key: '>150', label: '> 150 d' },
];
