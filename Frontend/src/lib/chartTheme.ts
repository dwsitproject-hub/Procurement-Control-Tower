import { Chart } from 'chart.js';

/**
 * Point Chart.js's global text and grid colours at the current theme.
 *
 * Chart.js paints to a canvas, so it cannot read CSS variables by itself: its
 * defaults (#666 text, light-grey grid) were chosen for a white page and turn
 * illegible on the dark theme. Called right before every chart is created, so a
 * chart always matches the theme that was active when it was drawn; switching
 * theme takes effect on the next redraw (navigation, filter change, reload).
 */
export function syncChartTheme(): void {
  if (typeof document === 'undefined') return;
  const cs = getComputedStyle(document.documentElement);
  const muted = cs.getPropertyValue('--muted').trim();
  const border = cs.getPropertyValue('--border').trim();
  const font = cs.getPropertyValue('--font-ui').trim();
  if (muted) Chart.defaults.color = muted;
  if (border) Chart.defaults.borderColor = border;
  if (font) Chart.defaults.font.family = font;
}
