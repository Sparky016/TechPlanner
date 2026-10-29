-- 0001_init: initial schema (SPEC_DOC §7.2), MySQL 8.4. `user` is reserved, hence app_user; so is `trigger`, which
-- every statement must quote. Audit append-only enforcement and the chain lock are added by 0002.
--
-- scripts/migrate.ts sends one statement per `statement-break` marker and replaces ${APP_DB_USER} with the app
-- account. DDL commits implicitly in MySQL, so a failure part-way leaves earlier statements applied.
--
-- Types (docs/specs/mysql-migration.md §4.1): uuids are CHAR(36) in ascii_general_ci, compared case-insensitively
-- like a Postgres uuid; every other text column is utf8mb4_0900_bin (byte-exact, case-sensitive, as Postgres
-- text). Timestamps are DATETIME(6) in UTC. Arrays are JSON arrays of strings. Foreign keys are table constraints:
-- MySQL ignores an inline column REFERENCES.

CREATE TABLE app_user (
  atlassian_account_id VARCHAR(128) NOT NULL PRIMARY KEY,
  display_name TEXT NOT NULL,
  email TEXT,
  data_notice_ack_at DATETIME(6),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin;

-- statement-break

CREATE TABLE oauth_token (
  user_id VARCHAR(128) NOT NULL PRIMARY KEY,
  enc_access_token BLOB NOT NULL,
  enc_refresh_token BLOB,
  expires_at DATETIME(6) NOT NULL,
  scopes JSON NOT NULL,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT oauth_token_user_fk FOREIGN KEY (user_id) REFERENCES app_user (atlassian_account_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin;

-- statement-break

-- Browser session (SR-1.5): id_hash is SHA-256 of the opaque random cookie value.
CREATE TABLE app_session (
  id_hash BINARY(32) NOT NULL PRIMARY KEY,
  user_id VARCHAR(128),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  last_seen_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  expires_at DATETIME(6) NOT NULL,
  CONSTRAINT app_session_user_fk FOREIGN KEY (user_id) REFERENCES app_user (atlassian_account_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin;

-- statement-break

CREATE TABLE planning_session (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL PRIMARY KEY DEFAULT (UUID()),
  primary_ticket_key VARCHAR(64) NOT NULL,
  ticket_keys JSON NOT NULL,
  facilitator_id VARCHAR(128),
  status VARCHAR(32) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'partially_published')),
  clarification_ended BOOLEAN NOT NULL DEFAULT FALSE,
  confluence_page_id VARCHAR(64),
  confluence_page_version INT,
  lock_holder VARCHAR(64),
  lock_expires_at DATETIME(6),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  KEY planning_session_primary_ticket_key_idx (primary_ticket_key),
  CONSTRAINT planning_session_facilitator_fk FOREIGN KEY (facilitator_id) REFERENCES app_user (atlassian_account_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin;

-- statement-break

CREATE TABLE source_snapshot (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_general_ci,
  kind VARCHAR(32) CHECK (kind IN ('jira_issue', 'confluence_page', 'attachment')),
  ref VARCHAR(512) NOT NULL,
  title TEXT,
  content_text LONGTEXT,
  ingest_status VARCHAR(32) CHECK (ingest_status IN ('ingested', 'listed', 'unavailable', 'truncated')),
  detail JSON NOT NULL DEFAULT (JSON_OBJECT()),
  retrieved_at DATETIME(6) NOT NULL,
  CONSTRAINT source_snapshot_session_fk FOREIGN KEY (session_id) REFERENCES planning_session (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin;

-- statement-break

CREATE TABLE conversation_message (
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  seq INT NOT NULL,
  role VARCHAR(32) CHECK (role IN ('facilitator', 'ai', 'note', 'system')),
  content MEDIUMTEXT NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (session_id, seq),
  CONSTRAINT conversation_message_session_fk FOREIGN KEY (session_id) REFERENCES planning_session (id)
    ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin;

-- statement-break

-- version is the optimistic-concurrency counter for the working copy.
CREATE TABLE working_copy (
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL PRIMARY KEY,
  sections JSON NOT NULL,
  version INT NOT NULL DEFAULT 0,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT working_copy_session_fk FOREIGN KEY (session_id) REFERENCES planning_session (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin;

-- statement-break

CREATE TABLE pending_suggestion (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL PRIMARY KEY DEFAULT (UUID()),
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_general_ci,
  section VARCHAR(64) NOT NULL,
  patch JSON NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  decided_at DATETIME(6),
  CONSTRAINT pending_suggestion_session_fk FOREIGN KEY (session_id) REFERENCES planning_session (id)
    ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin;

-- statement-break

CREATE TABLE revision (
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  number INT NOT NULL,
  sections JSON NOT NULL,
  `trigger` VARCHAR(32) CHECK (`trigger` IN ('save', 'restore', 'publish')),
  readiness_score INT,
  published BOOLEAN NOT NULL DEFAULT FALSE,
  author_id VARCHAR(128),
  restored_from INT,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (session_id, number),
  CONSTRAINT revision_session_fk FOREIGN KEY (session_id) REFERENCES planning_session (id),
  CONSTRAINT revision_author_fk FOREIGN KEY (author_id) REFERENCES app_user (atlassian_account_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin;

-- statement-break

-- Revisions are immutable; the only permitted update is marking published false -> true. Every other column must
-- be unchanged: a column added to revision later must be added to this comparison.
CREATE TRIGGER revision_immutable BEFORE UPDATE ON revision
FOR EACH ROW
BEGIN
  IF NOT (OLD.published = FALSE AND NEW.published = TRUE
          AND NEW.session_id <=> OLD.session_id
          AND NEW.number <=> OLD.number
          AND NEW.sections <=> OLD.sections
          AND NEW.`trigger` <=> OLD.`trigger`
          AND NEW.readiness_score <=> OLD.readiness_score
          AND NEW.author_id <=> OLD.author_id
          AND NEW.restored_from <=> OLD.restored_from
          AND NEW.created_at <=> OLD.created_at) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'revision is immutable (only published false -> true is allowed)';
  END IF;
END

-- statement-break

CREATE TABLE evaluation (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL PRIMARY KEY DEFAULT (UUID()),
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_general_ci,
  section_statuses JSON NOT NULL,
  score INT NOT NULL,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT evaluation_session_fk FOREIGN KEY (session_id) REFERENCES planning_session (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin;

-- statement-break

CREATE TABLE issue (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL PRIMARY KEY DEFAULT (UUID()),
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_general_ci,
  severity VARCHAR(32) CHECK (severity IN ('critical', 'warning', 'informational')),
  section VARCHAR(64) NOT NULL,
  description MEDIUMTEXT NOT NULL,
  fingerprint VARCHAR(128) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'accepted-risk')),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  resolved_at DATETIME(6),
  UNIQUE KEY issue_session_fingerprint (session_id, fingerprint),
  CONSTRAINT issue_session_fk FOREIGN KEY (session_id) REFERENCES planning_session (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin;

-- statement-break

CREATE TABLE ai_question (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL PRIMARY KEY DEFAULT (UUID()),
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_general_ci,
  issue_id CHAR(36) CHARACTER SET ascii COLLATE ascii_general_ci,
  section VARCHAR(64),
  text MEDIUMTEXT NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'dismissed')),
  dismiss_reason TEXT,
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT ai_question_session_fk FOREIGN KEY (session_id) REFERENCES planning_session (id) ON DELETE CASCADE,
  CONSTRAINT ai_question_issue_fk FOREIGN KEY (issue_id) REFERENCES issue (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin;

-- statement-break

CREATE TABLE publish_run (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL PRIMARY KEY DEFAULT (UUID()),
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_general_ci,
  revision_number INT NOT NULL,
  override_justification TEXT,
  steps JSON NOT NULL,
  status VARCHAR(32) CHECK (status IN ('running', 'completed', 'failed')),
  created_by VARCHAR(128),
  created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT publish_run_session_fk FOREIGN KEY (session_id) REFERENCES planning_session (id),
  CONSTRAINT publish_run_created_by_fk FOREIGN KEY (created_by) REFERENCES app_user (atlassian_account_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin;

-- statement-break

-- Deliberately no foreign keys: audit records must survive deletion of what they describe. Hashed text is
-- utf8mb4_0900_bin, so the stored bytes are the hashed bytes.
CREATE TABLE audit_record (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ts DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  user_id VARCHAR(128),
  user_display_name TEXT,
  session_id CHAR(36) CHARACTER SET ascii COLLATE ascii_general_ci,
  ticket_ids JSON,
  action VARCHAR(64) NOT NULL,
  result VARCHAR(32) NOT NULL CHECK (result IN ('success', 'failure')),
  details JSON NOT NULL DEFAULT (JSON_OBJECT()),
  correlation_id VARCHAR(255),
  prev_hash VARBINARY(64),
  hash VARBINARY(64) NOT NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin;

-- statement-break

-- The app user's privileges, per table (§11a): a database-wide grant could not exclude audit_record.
GRANT SELECT, INSERT, UPDATE, DELETE ON app_user TO ${APP_DB_USER}
-- statement-break
GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_token TO ${APP_DB_USER}
-- statement-break
GRANT SELECT, INSERT, UPDATE, DELETE ON app_session TO ${APP_DB_USER}
-- statement-break
GRANT SELECT, INSERT, UPDATE, DELETE ON planning_session TO ${APP_DB_USER}
-- statement-break
GRANT SELECT, INSERT, UPDATE, DELETE ON source_snapshot TO ${APP_DB_USER}
-- statement-break
GRANT SELECT, INSERT, UPDATE, DELETE ON conversation_message TO ${APP_DB_USER}
-- statement-break
GRANT SELECT, INSERT, UPDATE, DELETE ON working_copy TO ${APP_DB_USER}
-- statement-break
GRANT SELECT, INSERT, UPDATE, DELETE ON pending_suggestion TO ${APP_DB_USER}
-- statement-break
-- The revision_immutable trigger refuses every UPDATE except marking a revision published.
GRANT SELECT, INSERT, UPDATE, DELETE ON revision TO ${APP_DB_USER}
-- statement-break
GRANT SELECT, INSERT, UPDATE, DELETE ON evaluation TO ${APP_DB_USER}
-- statement-break
GRANT SELECT, INSERT, UPDATE, DELETE ON issue TO ${APP_DB_USER}
-- statement-break
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_question TO ${APP_DB_USER}
-- statement-break
GRANT SELECT, INSERT, UPDATE, DELETE ON publish_run TO ${APP_DB_USER}
-- statement-break
-- Append-only: no UPDATE, DELETE or DROP (which TRUNCATE needs).
GRANT SELECT, INSERT ON audit_record TO ${APP_DB_USER}
