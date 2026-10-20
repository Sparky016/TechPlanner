-- The Azure DevOps repository the facilitator picked for a session's code investigation (ADR-0016).
-- NULL means no repository was picked: the agent searches every allowed repository.

ALTER TABLE planning_session ADD COLUMN code_repository text;
