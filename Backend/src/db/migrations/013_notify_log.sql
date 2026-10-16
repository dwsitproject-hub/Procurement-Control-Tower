-- 013: outbound notification log (user request 6 Aug 2026).
--
-- Serves three purposes: the hourly rate limit is enforced against real sends
-- rather than an in-memory counter that a restart would forget, the Admin panel
-- can show what was actually sent, and a failed send is recorded instead of
-- disappearing into a log file.
CREATE TABLE IF NOT EXISTS ops.notify_log (
  id          bigserial PRIMARY KEY,
  sent_at     timestamptz NOT NULL DEFAULT now(),
  event       text NOT NULL,
  subject     text NOT NULL,
  recipients  text[] NOT NULL,
  status      text NOT NULL CHECK (status IN ('sent', 'failed', 'suppressed')),
  error       text,
  -- The rendered summary, so an admin can see exactly what was reported.
  body_text   text
);

CREATE INDEX IF NOT EXISTS ix_notify_log_recent ON ops.notify_log (sent_at DESC);
