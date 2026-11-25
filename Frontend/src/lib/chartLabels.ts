/**
 * Bar value labels that never print over each other (21 Nov 2026).
 *
 * Labels were drawn centred above every bar with no regard for the next one,
 * so grouped series and narrow bars overprinted into an unreadable smear. Now
 * each label is placed where it fits - horizontally if it is no wider than its
 * bar, otherwise turned upright - and a label that would still touch one
 * already drawn is skipped (the tooltip always carries the figure).
 */
export interface LabelRect { x0: number; y0: number; x1: number; y1: number }

const overlaps = (a: LabelRect, b: LabelRect): boolean =>
  a.x0 < b.x1 + 2 && b.x0 < a.x1 + 2 && a.y0 < b.y1 + 1 && b.y0 < a.y1 + 1;

/**
 * Above a vertical bar whose top is at topY and whose width is barWidth. An
 * upright label with no room above the bar (the tallest bars) goes INSIDE it,
 * in white, when the bar is tall enough - base is the bar's bottom.
 */
export function placeLabelAbove(
  ctx: CanvasRenderingContext2D, placed: LabelRect[], text: string,
  cx: number, topY: number, barWidth: number, base?: number,
): boolean {
  const w = ctx.measureText(text).width;
  const h = 11;
  const upright = w > barWidth + 6;
  const rect: LabelRect = upright
    ? { x0: cx - h / 2, x1: cx + h / 2, y0: topY - 3 - w, y1: topY - 3 }
    : { x0: cx - w / 2, x1: cx + w / 2, y0: topY - 2 - h, y1: topY - 2 };
  if (rect.y0 < 0 && base !== undefined && base - topY >= w + 10 && barWidth >= h) {
    const inside: LabelRect = { x0: cx - h / 2, x1: cx + h / 2, y0: topY + 4, y1: topY + 4 + w };
    if (placed.some((p) => overlaps(p, inside))) return false;
    ctx.save();
    ctx.translate(cx, topY + 4);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#fff';
    ctx.fillText(text, 0, 0);
    ctx.restore();
    placed.push(inside);
    return true;
  }
  if (rect.y0 < 0 || placed.some((p) => overlaps(p, rect))) return false;
  ctx.save();
  if (upright) {
    ctx.translate(cx, topY - 3);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 0, 0);
  } else {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(text, cx, topY - 2);
  }
  ctx.restore();
  placed.push(rect);
  return true;
}

/** Anywhere, centred on (cx, cy): the waterfall's segment numbers. */
export function placeLabelAt(
  ctx: CanvasRenderingContext2D, placed: LabelRect[], text: string, cx: number, cy: number, stroke = false,
): boolean {
  const w = ctx.measureText(text).width;
  const rect: LabelRect = { x0: cx - w / 2, x1: cx + w / 2, y0: cy - 6, y1: cy + 6 };
  if (placed.some((p) => overlaps(p, rect))) return false;
  if (stroke) ctx.strokeText(text, cx, cy);
  ctx.fillText(text, cx, cy);
  placed.push(rect);
  return true;
}
