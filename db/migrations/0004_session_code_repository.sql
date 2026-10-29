-- The Azure DevOps repository the facilitator picked for a session's code investigation (ADR-0016).
-- NULL means no repository was picked: the agent searches every allowed repository.
-- 256 is CODE_REPOSITORY_MAX (src/server/sessions/codeRepository.ts).

ALTER TABLE planning_session ADD COLUMN code_repository VARCHAR(256)
