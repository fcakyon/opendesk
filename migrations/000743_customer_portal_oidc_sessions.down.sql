DELETE FROM customer_sessions s WHERE NOT EXISTS (
    SELECT 1 FROM customer_credentials a WHERE a.workspace_id = s.workspace_id AND a.contact_id = s.contact_id);
ALTER TABLE customer_sessions DROP CONSTRAINT customer_sessions_contact_fkey;
ALTER TABLE customer_sessions DROP COLUMN method;
ALTER TABLE customer_sessions ADD CONSTRAINT customer_sessions_workspace_id_contact_id_fkey
    FOREIGN KEY (workspace_id, contact_id) REFERENCES customer_credentials(workspace_id, contact_id) ON DELETE CASCADE;
ALTER TABLE brands DROP COLUMN portal_oidc_create_contacts;
CREATE OR REPLACE FUNCTION invalidate_customer_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.blocked OR NEW.email IS DISTINCT FROM OLD.email THEN
        DELETE FROM customer_credentials WHERE workspace_id = OLD.workspace_id AND contact_id = OLD.id;
        DELETE FROM customer_password_resets WHERE workspace_id = OLD.workspace_id AND contact_id = OLD.id;
    END IF;
    RETURN NEW;
END;
$$;
