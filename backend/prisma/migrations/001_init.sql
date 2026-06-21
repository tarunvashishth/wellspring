-- Run as superuser, then switch to app_user for the application

-- Create application role
DO $$ BEGIN
  CREATE ROLE app_user NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Grant connect and schema usage
GRANT CONNECT ON DATABASE postgres TO app_user;
GRANT USAGE ON SCHEMA public TO app_user;

-- current_tenant_id() — fails closed (returns NULL UUID = no rows)
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT NULLIF(current_setting('app.current_tenant', true), '')::uuid
  $$;

-- Tables (Prisma manages DDL; this migration adds RLS on top)
-- Run `prisma migrate dev` first, then apply this file.

-- Enable RLS on all tenant tables
ALTER TABLE creators         ENABLE ROW LEVEL SECURITY;
ALTER TABLE programs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE media             ENABLE ROW LEVEL SECURITY;
ALTER TABLE bulk_imports      ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_errors     ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs        ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;

-- Force RLS even for table owners
ALTER TABLE creators              FORCE ROW LEVEL SECURITY;
ALTER TABLE programs              FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions              FORCE ROW LEVEL SECURITY;
ALTER TABLE media                 FORCE ROW LEVEL SECURITY;
ALTER TABLE bulk_imports          FORCE ROW LEVEL SECURITY;
ALTER TABLE import_errors         FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_logs            FORCE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens FORCE ROW LEVEL SECURITY;

-- RLS policies — direct creator_id comparison on every table
-- import_errors: denormalized creator_id avoids correlated subquery
CREATE POLICY creators_isolation ON creators
  USING (id = current_tenant_id());

CREATE POLICY programs_isolation ON programs
  USING (creator_id = current_tenant_id());

CREATE POLICY sessions_isolation ON sessions
  USING (creator_id = current_tenant_id());

CREATE POLICY media_isolation ON media
  USING (creator_id = current_tenant_id());

CREATE POLICY bulk_imports_isolation ON bulk_imports
  USING (creator_id = current_tenant_id());

CREATE POLICY import_errors_isolation ON import_errors
  USING (creator_id = current_tenant_id());

CREATE POLICY audit_logs_isolation ON audit_logs
  USING (creator_id = current_tenant_id());

CREATE POLICY password_reset_tokens_isolation ON password_reset_tokens
  USING (creator_id = current_tenant_id());

-- Grant DML to app_user
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- Deferred unique constraint for session position (allows safe reorder within transaction)
ALTER TABLE sessions
  DROP CONSTRAINT IF EXISTS sessions_program_id_position_key;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_program_id_position_unique
  UNIQUE (program_id, position)
  DEFERRABLE INITIALLY DEFERRED;

-- Composite FK ensures cross-tenant program assignment is impossible at DB level
ALTER TABLE sessions
  DROP CONSTRAINT IF EXISTS sessions_program_id_creator_id_fkey;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_program_id_creator_id_fkey
  FOREIGN KEY (program_id, creator_id) REFERENCES programs (id, creator_id)
  ON DELETE CASCADE;

-- Composite unique on programs (needed by the composite FK above)
ALTER TABLE programs
  ADD CONSTRAINT IF NOT EXISTS programs_id_creator_id_unique
  UNIQUE (id, creator_id);
