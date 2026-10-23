-- 039 - section and card titles, renamed by an Admin.
--
-- Requested 23 Oct 2026: an Admin can rename any section or card title on any
-- page, and the new name applies to every user straight away. The defaults
-- stay in the code; this table holds only the renames, so resetting a title
-- is deleting its row and the page shows its built-in text again.
--
-- label_key   which title. '<page>::<built-in text>' for a page's own
--             headings (so a heading renamed on one page is not renamed on
--             another that happens to use the same words), 'chart:<chartId>'
--             and 'kpi:<kpiId>' for charts and KPI cards, which keep their name
--             on every page they appear on.
-- default_text the built-in text when it was renamed, so the Admin list can
--             say what a title used to be, and a key whose built-in text
--             later changes in the code can still be recognised.
--
-- Not versioned with the dataset: titles are presentation, and a rename
-- applies to every dataset version at once. Every change is in the audit log
-- (ui.label.set / ui.label.reset).

CREATE TABLE IF NOT EXISTS app.ui_label (
  label_key    text PRIMARY KEY CHECK (length(label_key) BETWEEN 1 AND 300),
  label        text NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  default_text text,
  updated_by   text NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
