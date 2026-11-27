/**
 * What a card's coloured dot means (27 Nov 2026, requested on PR Analysis).
 * Hovering a card names its own thresholds; this says the rule once.
 */
export function DotLegend() {
  const item = (color: string, text: string) => (
    <span className="dot-legend-i">
      <span className="dot-legend-d" style={{ background: color }} aria-hidden="true" />
      {text}
    </span>
  );
  return (
    <p className="dot-legend" aria-label="What the card dots mean">
      <span className="dot-legend-h">Card dot:</span>
      {item('var(--good)', 'within target')}
      {item('var(--warn)', 'past the warning threshold')}
      {item('var(--crit)', 'past the critical threshold')}
      {item('var(--sev-none, #94a3b8)', 'no target — information only')}
      <span className="muted">· hover a card for its thresholds</span>
    </p>
  );
}
