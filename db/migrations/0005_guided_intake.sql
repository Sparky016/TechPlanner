-- Guided intake (docs/specs/guided-intake-and-question-answering.md §7): when a session's sources were
-- ingested and first analyzed, each AI question's answer and resolution, and which message answers which question.
-- Expand step: 'dismissed' stays allowed for one release; the contract step drops it and renames dismiss_reason.

ALTER TABLE planning_session
  ADD COLUMN ingested_at timestamptz,
  ADD COLUMN analyzed_at timestamptz;

ALTER TABLE ai_question
  ADD COLUMN answer_text text,
  ADD COLUMN answered_at timestamptz,
  ADD COLUMN answered_via text CHECK (answered_via IN ('facilitator', 'ai')),
  ADD COLUMN resolution text CHECK (resolution IN ('answered', 'not_relevant')),
  ADD COLUMN resolved_at timestamptz;

-- Status 'resolved' replaces 'dismissed'. 'dismissed' stays allowed for one release (expand/contract).
ALTER TABLE ai_question DROP CONSTRAINT ai_question_status_check;
ALTER TABLE ai_question ADD CONSTRAINT ai_question_status_check
  CHECK (status IN ('open', 'answered', 'resolved', 'dismissed'));

UPDATE ai_question
   SET status = 'resolved', resolution = 'not_relevant', resolved_at = created_at
 WHERE status = 'dismissed';

ALTER TABLE conversation_message ADD COLUMN question_id uuid REFERENCES ai_question (id);

-- Existing sessions were ingested at creation; do not ask them to ingest or analyze again (GD-6).
UPDATE planning_session p
   SET ingested_at = s.first_retrieved,
       analyzed_at = s.first_retrieved
  FROM (SELECT session_id, min(retrieved_at) AS first_retrieved FROM source_snapshot GROUP BY session_id) s
 WHERE s.session_id = p.id;
