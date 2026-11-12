/**
 * The Signal Tower glyph: the app icon (public/icon.svg) without its navy tile,
 * for surfaces that are already navy, like the top bar. Drawn inline rather
 * than loaded as an <img> so it paints with the bar and costs no request.
 * Decorative: the title next to it carries the name.
 */
export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      viewBox="8 6 48 50"
      width={size}
      height={Math.round((size * 50) / 48)}
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <rect x="14" y="41" width="8" height="12" rx="2" fill="#6AA9E9" />
      <rect x="28" y="31" width="8" height="22" rx="2" fill="#FFFFFF" />
      <rect x="42" y="37" width="8" height="16" rx="2" fill="#6AA9E9" />
      <path d="M25.9 20.5 A7 7 0 0 1 38.1 20.5" fill="none" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" />
      <path
        d="M21.6 18 A12 12 0 0 1 42.4 18"
        fill="none"
        stroke="#FFFFFF"
        strokeOpacity="0.5"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <circle cx="32" cy="24" r="3.2" fill="#ED7D31" />
    </svg>
  );
}
