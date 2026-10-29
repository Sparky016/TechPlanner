-- One-time MySQL 8.4 setup for TechPlanner (docs/specs/mysql-migration.md §11a). Run as root:
--   mysql -uroot -p < scripts/mysql-bootstrap.sql
-- Safe to re-run: it creates only what is missing and never changes an existing password.
--
-- DEV-ONLY PASSWORDS. 'owner-dev-password' and 'app-dev-password' are for a developer machine and CI. Production
-- creates the users with generated passwords and the hosts narrowed to the Docker bridge subnet (task 48 runbook).
--
-- Two users:
--   techplanner_owner  DDL; runs migrations (MIGRATE_DATABASE_URL) and grants table privileges to the app user.
--   techplanner_app    DML only; used by web and worker (DATABASE_URL). It gets no database-wide grant: every
--                      migration that creates a table grants on that table, and audit_record gets SELECT, INSERT
--                      only, so the app cannot UPDATE, DELETE or TRUNCATE audit records.

CREATE DATABASE IF NOT EXISTS techplanner CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
-- Integration tests (tests/integration) migrate and reset this one.
CREATE DATABASE IF NOT EXISTS techplanner_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE USER IF NOT EXISTS 'techplanner_owner'@'%' IDENTIFIED BY 'owner-dev-password';
CREATE USER IF NOT EXISTS 'techplanner_app'@'%' IDENTIFIED BY 'app-dev-password';

GRANT ALL PRIVILEGES ON techplanner.* TO 'techplanner_owner'@'%' WITH GRANT OPTION;
-- Dev and CI only (omit in production): the test harnesses drop and re-create their own databases, all named
-- techplanner_<something> (techplanner_test, techplanner_e2e, techplanner_perf, techplanner_eval, techplanner_tNN).
GRANT ALL PRIVILEGES ON `techplanner\_%`.* TO 'techplanner_owner'@'%' WITH GRANT OPTION;

-- MySQL enables the binary log by default, and with it CREATE TRIGGER needs SUPER unless this is ON. The schema's
-- triggers (migrations 0001, 0002) only compare columns and SIGNAL, so they replicate safely. Deprecated in 8.4
-- (a warning) but still the only alternative to giving the owner SUPER. Production sets it in the server config.
SET PERSIST log_bin_trust_function_creators = ON;
