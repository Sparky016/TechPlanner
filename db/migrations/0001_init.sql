-- 0001_init: initial schema (SPEC_DOC §7.2). `user` is reserved, hence app_user.
-- Audit append-only enforcement and hash chain are added by a later migration.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE app_user (
  atlassian_account_id text PRIMARY KEY,
  display_name text NOT NULL,
  email text,
  data_notice_ack_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_token (
  user_id text PRIMARY KEY REFERENCES app_user (atlassian_account_id),
  enc_access_token bytea NOT NULL,
  enc_refresh_token bytea,
  expires_at timestamptz NOT NULL,
  scopes text[] NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Browser session (SR-1.5): id_hash is SHA-256 of the opaque random cookie value.
CREATE TABLE app_session (
  id_hash bytea PRIMARY KEY,
  user_id text REFERENCES app_user (atlassian_account_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE planning_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  primary_ticket_key text NOT NULL,
  ticket_keys text[] NOT NULL,
  facilitator_id text REFERENCES app_user (atlassian_account_id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'partially_published')),
  clarification_ended boolean NOT NULL DEFAULT false,
  confluence_page_id text,
  confluence_page_version int,
  lock_holder text,
  lock_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX planning_session_primary_ticket_key_idx ON planning_session (primary_ticket_key);

CREATE TABLE source_snapshot (
  id bigserial PRIMARY KEY,
  session_id uuid REFERENCES planning_session (id) ON DELETE CASCADE,
  kind text CHECK (kind IN ('jira_issue', 'confluence_page', 'attachment')),
  ref text NOT NULL,
  title text,
  content_text text,
  ingest_status text CHECK (ingest_status IN ('ingested', 'listed', 'unavailable', 'truncated')),
  detail jsonb NOT NULL DEFAULT '{}',
  retrieved_at timestamptz NOT NULL
);

CREATE TABLE conversation_message (
  session_id uuid REFERENCES planning_session (id) ON DELETE CASCADE,
  seq int,
  role text CHECK (role IN ('facilitator', 'ai', 'note', 'system')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, seq)
);

-- version is the optimistic-concurrency counter for the working copy.
CREATE TABLE working_copy (
  session_id uuid PRIMARY KEY REFERENCES planning_session (id) ON DELETE CASCADE,
  sections jsonb NOT NULL,
  version int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE pending_suggestion (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES planning_session (id) ON DELETE CASCADE,
  section text NOT NULL,
  patch jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

CREATE TABLE revision (
  session_id uuid REFERENCES planning_session (id),
  number int,
  sections jsonb NOT NULL,
  trigger text CHECK (trigger IN ('save', 'restore', 'publish')),
  readiness_score int,
  published boolean NOT NULL DEFAULT false,
  author_id text REFERENCES app_user (atlassian_account_id),
  restored_from int,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, number)
);

-- Revisions are immutable; the only permitted update is marking published false -> true.
CREATE FUNCTION revision_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  expected revision%ROWTYPE;
BEGIN
  expected := OLD;
  expected.published := true;
  IF OLD.published = false AND NEW.published = true AND NEW IS NOT DISTINCT FROM expected THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'revision is immutable (only published false -> true is allowed)'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER revision_immutable
  BEFORE UPDATE ON revision
  FOR EACH ROW EXECUTE FUNCTION revision_immutable();

CREATE TABLE evaluation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES planning_session (id) ON DELETE CASCADE,
  section_statuses jsonb NOT NULL,
  score int NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE issue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES planning_session (id) ON DELETE CASCADE,
  severity text CHECK (severity IN ('critical', 'warning', 'informational')),
  section text NOT NULL,
  description text NOT NULL,
  fingerprint text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'accepted-risk')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE (session_id, fingerprint)
);

CREATE TABLE ai_question (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES planning_session (id) ON DELETE CASCADE,
  issue_id uuid REFERENCES issue (id),
  section text,
  text text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'dismissed')),
  dismiss_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE publish_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES planning_session (id),
  revision_number int NOT NULL,
  override_justification text,
  steps jsonb NOT NULL,
  status text CHECK (status IN ('running', 'completed', 'failed')),
  created_by text REFERENCES app_user (atlassian_account_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Deliberately no foreign keys: audit records must survive deletion of what they describe.
CREATE TABLE audit_record (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  user_id text,
  user_display_name text,
  session_id uuid,
  ticket_ids text[],
  action text NOT NULL,
  result text NOT NULL CHECK (result IN ('success', 'failure')),
  details jsonb NOT NULL DEFAULT '{}',
  correlation_id text,
  prev_hash bytea,
  hash bytea NOT NULL
);
