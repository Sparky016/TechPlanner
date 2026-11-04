-- Guided intake (docs/specs/guided-intake-and-question-answering.md §7): when a session's sources were
-- ingested and first analyzed, each AI question's answer and resolution, and which message answers which question.
-- Expand step: 'dismissed' stays allowed for one release; the contract step drops it and renames dismiss_reason.
-- MySQL commits each DDL statement on its own: every chunk below is one ALTER (atomic by itself) or one UPDATE.
-- Only existing tables change, so no new grants: the app user's table grants cover the new columns.

ALTER TABLE planning_session
  ADD COLUMN ingested_at DATETIME(6),
  ADD COLUMN analyzed_at DATETIME(6)

-- statement-break

ALTER TABLE ai_question
  ADD COLUMN answer_text MEDIUMTEXT,
  ADD COLUMN answered_at DATETIME(6),
  ADD COLUMN answered_via VARCHAR(32),
  ADD COLUMN resolution VARCHAR(32),
  ADD COLUMN resolved_at DATETIME(6),
  ADD CONSTRAINT ai_question_answered_via_check CHECK (answered_via IN ('facilitator', 'ai')),
  ADD CONSTRAINT ai_question_resolution_check CHECK (resolution IN ('answered', 'not_relevant'))

-- statement-break

-- Status 'resolved' replaces 'dismissed'. 'dismissed' stays allowed for one release (expand/contract).
-- 0001_init.sql declares the status CHECK inline, so MySQL named it ai_question_chk_1; its replacement gets an
-- explicit name so the contract step can drop it by name. One ALTER, so the status is never unchecked.
ALTER TABLE ai_question
  DROP CHECK ai_question_chk_1,
  ADD CONSTRAINT ai_question_status_check CHECK (status IN ('open', 'answered', 'resolved', 'dismissed'))

-- statement-break

UPDATE ai_question
   SET status = 'resolved', resolution = 'not_relevant', resolved_at = created_at
 WHERE status = 'dismissed'

-- statement-break

ALTER TABLE conversation_message
  ADD COLUMN question_id CHAR(36) CHARACTER SET ascii COLLATE ascii_general_ci,
  ADD CONSTRAINT conversation_message_question_fk FOREIGN KEY (question_id) REFERENCES ai_question (id)

-- statement-break

-- Existing sessions were ingested at creation; do not ask them to ingest or analyze again (GD-6).
UPDATE planning_session p
  JOIN (SELECT session_id, MIN(retrieved_at) AS first_retrieved FROM source_snapshot GROUP BY session_id) s
    ON s.session_id = p.id
   SET p.ingested_at = s.first_retrieved,
       p.analyzed_at = s.first_retrieved
