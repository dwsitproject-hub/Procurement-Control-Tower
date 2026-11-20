-- 049 - one page layout for everyone, set by an Admin (21 Nov 2026).
--
-- Until now each user arranged their own pages (`tab_layout_<tab>` in their
-- preferences) and anyone could. Requested 21 Nov 2026: only an Admin edits a
-- page's layout, and the arrangement the Admin makes is what every user sees -
-- the same rule 039 set for titles.
--
-- One row per page: the layout object the page already understood (order,
-- hidden, swapped and added cards and charts, panel order). No row = the
-- page's built-in arrangement. Per-user layouts and named views left in
-- preferences are simply no longer read; nothing is deleted. Every change is
-- in the audit log (ui.layout.set).

CREATE TABLE IF NOT EXISTS app.ui_layout (
  tab        text PRIMARY KEY CHECK (tab ~ '^[a-z0-9_-]{1,40}$'),
  layout     jsonb NOT NULL,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
