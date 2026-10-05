-- Debounce state for user.edit (SR-4.4: per section per 30 s) and draft.updated (SR-10.3: per session per 5 min).
-- baseline_body is the section body as of the last user.edit audit (or before the first unaudited edit);
-- last_audit_at starts the current 30 s window.

CREATE TABLE edit_audit_state (
  session_id uuid REFERENCES planning_session (id) ON DELETE CASCADE,
  section text,
  baseline_body text NOT NULL,
  last_audit_at timestamptz NOT NULL,
  PRIMARY KEY (session_id, section)
);

ALTER TABLE working_copy ADD COLUMN last_draft_updated_audit_at timestamptz;
