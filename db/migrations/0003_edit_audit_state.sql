-- Debounce state for user.edit (SR-4.4: per section per 30 s) and draft.updated (SR-10.3: per session per 5 min).
-- baseline_body is the section body as of the last user.edit audit (or before the first unaudited edit);
-- last_audit_at starts the current 30 s window.

CREATE TABLE edit_audit_state (
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  section VARCHAR(64) NOT NULL,
  baseline_body MEDIUMTEXT NOT NULL,
  last_audit_at DATETIME(6) NOT NULL,
  PRIMARY KEY (session_id, section),
  CONSTRAINT edit_audit_state_session_fk FOREIGN KEY (session_id) REFERENCES planning_session (id)
    ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin;

-- statement-break

GRANT SELECT, INSERT, UPDATE, DELETE ON edit_audit_state TO ${APP_DB_USER}

-- statement-break

ALTER TABLE working_copy ADD COLUMN last_draft_updated_audit_at DATETIME(6)
