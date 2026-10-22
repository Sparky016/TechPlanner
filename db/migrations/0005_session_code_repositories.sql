-- The Azure DevOps repositories the facilitator picked for a session's code investigation (ADR-0016).
-- Replaces the single code_repository pick. An empty array means none was picked: the agent searches every allowed
-- repository.

ALTER TABLE planning_session ADD COLUMN code_repositories text[] NOT NULL DEFAULT '{}';
UPDATE planning_session SET code_repositories = ARRAY[code_repository] WHERE code_repository IS NOT NULL;
ALTER TABLE planning_session DROP COLUMN code_repository;
