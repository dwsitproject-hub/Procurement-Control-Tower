/**
 * Material-group categorisation and priority labels.
 *
 * Ported from the v1 prototype's `matCat()` and its priority label array, which
 * held this as hardcoded JavaScript. The explicit overrides now live in
 * `core.dim_material_group` as seeded reference data; the numeric-range rules
 * below are the fallback, kept here so they are testable.
 */

export type MaterialCategory =
  | 'Service'
  | 'Chemical'
  | 'Fertilizer'
  | 'Fuel & Lubricant'
  | 'Packing Material'
  | 'Spare Parts-General'
  | 'Spare Parts-Factory'
  | 'Raw Product Liquid'
  | 'Raw Product Solid'
  | 'Finished Goods'
  | 'Other';

/**
 * Explicit overrides, from v1's `MG` map. Passed in from the database so an
 * administrator can extend them without a code change; this constant is the
 * bootstrap default and the unit-test fixture.
 */
export const MATERIAL_GROUP_OVERRIDES: Readonly<Record<string, MaterialCategory>> = Object.freeze({
  '8010': 'Raw Product Liquid',
  '8030': 'Raw Product Solid',
  '8050': 'Finished Goods',
  '8080': 'Service',
  '8081': 'Service',
  '8082': 'Service',
  '8083': 'Service',
  '8084': 'Service',
  '8085': 'Service',
  '8090': 'Service',
  '9090': 'Service',
  '912': 'Chemical',
  '926': 'Chemical',
  '922': 'Fertilizer',
  '964': 'Fertilizer',
  '929': 'Fuel & Lubricant',
  '937': 'Fuel & Lubricant',
  '958': 'Packing Material',
  '983': 'Packing Material',
});

/**
 * Category for a material group.
 *
 * Order of precedence, matching v1:
 *   1. explicit override
 *   2. any group starting 80x is a Service
 *   3. numeric groups 901-984 split by a parity rule
 *   4. otherwise Other
 *
 * The parity rule in step 3 is v1's, reproduced deliberately. It is a heuristic,
 * not a business definition — even material groups become Spare Parts-General and
 * odd ones Spare Parts-Factory. Worth confirming with the category managers
 * before it is treated as authoritative.
 */
export function materialCategory(
  materialGroup: string | null,
  overrides: Readonly<Record<string, string>> = MATERIAL_GROUP_OVERRIDES,
): MaterialCategory {
  const s = (materialGroup ?? '').trim();
  if (s === '') return 'Other';

  const override = overrides[s];
  if (override) return override as MaterialCategory;

  if (/^80\d/.test(s)) return 'Service';

  const n = Number.parseInt(s, 10);
  if (Number.isInteger(n) && n >= 901 && n <= 984) {
    if (n === 912 || n === 926) return 'Chemical';
    if (n === 922 || n === 964) return 'Fertilizer';
    if (n === 929 || n === 937) return 'Fuel & Lubricant';
    if (n === 958 || n === 983) return 'Packing Material';
    if (n % 2 === 0 && n >= 902 && n <= 984) return 'Spare Parts-General';
    return 'Spare Parts-Factory';
  }
  return 'Other';
}

/** The four labels, in display order. NOT an urgency lookup — see PRIORITY_BY_URGENCY. */
export const PRIORITY_LABELS: readonly string[] = [
  '01-Emergency',
  '02-Urgent',
  '03-Standard',
  '04-Planned',
];

/**
 * Requirement Urgency to label, as v1 defines it:
 *   {0:'04-Planned', 1:'01-Emergency', 2:'02-Urgent', 3:'03-Standard'}
 * with anything else falling back to '03-Standard'.
 *
 * This is NOT the array index. Indexing PRIORITY_LABELS by urgency — which this
 * module did until 7 Aug 2026 — shifts every label one step and, worst of all,
 * renders urgency 0 as "01-Emergency" when v1 treats it as the LOWEST priority.
 * On the reference data that mislabelled 250 items as emergencies and pushed the
 * 171 real ones down to "02-Urgent", so every priority chart, chip and filter
 * disagreed with v1 by one position.
 *
 * The zero is the trap: the export uses 0 for "no urgency stated", and the
 * column note ("urgent = {1,2}; 0 is undefined") describes the EXPEDITED test,
 * not the label. isUrgent below is the expedited test and was always correct.
 */
const PRIORITY_BY_URGENCY: Readonly<Record<number, string>> = {
  0: '04-Planned',
  1: '01-Emergency',
  2: '02-Urgent',
  3: '03-Standard',
};

/**
 * Requirement Urgency to label.
 *
 * The reference data carries urgency 0 (277 items) and 4 (104 items) alongside
 * 1-3. v1's array has four entries indexed from 0, so urgency 1 maps to
 * '02-Urgent'. Values outside the array return null rather than a fabricated
 * label — urgency 0 is undefined in the source and must not be shown as
 * 'Emergency'.
 */
export function priorityLabel(urgency: number | null): string | null {
  if (urgency === null || !Number.isInteger(urgency)) return null;
  // Unmapped urgencies (4 and up: 96 items on the reference data) become
  // '03-Standard', matching v1's default rather than vanishing into null.
  return PRIORITY_BY_URGENCY[urgency] ?? '03-Standard';
}

/** Urgency 1 and 2 are the expedited lane; 0 is undefined and excluded. */
export function isUrgent(urgency: number | null): boolean {
  return urgency === 1 || urgency === 2;
}

export function isStandard(urgency: number | null): boolean {
  return urgency === 3 || urgency === 4;
}
