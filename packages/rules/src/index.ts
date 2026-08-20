/**
 * @pct/rules — the correctness core of the Procurement Control Tower.
 *
 * Pure functions over plain data: no database, no HTTP, no environment, and no
 * access to the system clock except where a caller passes a date in explicitly.
 *
 * Every business number the product publishes is computed here, so this package
 * is the unit under test for the golden-number regression suite.
 */

export * from './coerce.js';
export * from './movement.js';
export * from './sto.js';
export * from './wbs.js';
export * from './aging.js';
export * from './fx.js';
export * from './status.js';
export * from './gr.js';
export * from './linkage.js';
export * from './stats.js';
export * from './category.js';
export * from './size_band.js';
