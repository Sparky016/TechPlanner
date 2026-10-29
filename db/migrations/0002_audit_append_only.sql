-- Audit Records are append-only (SR-12.3, D-13). The triggers reject UPDATE and DELETE for every user, including
-- the owner. MySQL has no TRUNCATE trigger: TRUNCATE is refused to the app user by privileges (0001 grants it
-- SELECT, INSERT only on audit_record; TRUNCATE needs DROP). The owner can still truncate; accepted in ADR-0013.

CREATE TRIGGER audit_record_no_update BEFORE UPDATE ON audit_record
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_record is append-only: UPDATE is not allowed'

-- statement-break

CREATE TRIGGER audit_record_no_delete BEFORE DELETE ON audit_record
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_record is append-only: DELETE is not allowed'

-- statement-break

-- Named transaction locks (src/server/db/locks.ts withTxLock): a writer holds the row's exclusive lock until it
-- commits. 'audit_chain' serialises audit chain writers; other names (refresh:<user id>) are created on first use.
CREATE TABLE app_lock (
  name VARCHAR(255) NOT NULL PRIMARY KEY
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_0900_bin;

-- statement-break

INSERT INTO app_lock (name) VALUES ('audit_chain')

-- statement-break

GRANT SELECT, INSERT, UPDATE, DELETE ON app_lock TO ${APP_DB_USER}
