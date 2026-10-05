-- Audit Records are append-only (SR-12.3, D-13): the database rejects UPDATE, DELETE and TRUNCATE.
-- The triggers enforce this for every role, including the table owner; the REVOKE is defence in depth.

CREATE FUNCTION audit_record_reject_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_record is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_record_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_record
  FOR EACH ROW EXECUTE FUNCTION audit_record_reject_change();

CREATE TRIGGER audit_record_no_truncate
  BEFORE TRUNCATE ON audit_record
  FOR EACH STATEMENT EXECUTE FUNCTION audit_record_reject_change();

REVOKE UPDATE, DELETE, TRUNCATE ON audit_record FROM PUBLIC;
