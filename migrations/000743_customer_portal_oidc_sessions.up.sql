-- A portal session belongs to the contact. A password credential is one way to sign in,
-- not a requirement: a contact who signs in through the brand's identity provider has none.
ALTER TABLE customer_sessions DROP CONSTRAINT customer_sessions_workspace_id_contact_id_fkey;
ALTER TABLE customer_sessions
    ADD COLUMN method text NOT NULL DEFAULT 'password' CHECK (method IN ('password', 'oidc')),
    ADD CONSTRAINT customer_sessions_contact_fkey FOREIGN KEY (workspace_id, contact_id) REFERENCES contacts(workspace_id, id) ON DELETE CASCADE;
ALTER TABLE brands ADD COLUMN portal_oidc_create_contacts boolean NOT NULL DEFAULT false;

-- A changed address or a block ends every way the contact signed in: sessions no longer
-- follow from the password row, so they are removed here, with the live provider links. A
-- contact that loses a link asks for an admin's relink authorization before the next one.
CREATE OR REPLACE FUNCTION invalidate_customer_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.blocked OR NEW.email IS DISTINCT FROM OLD.email THEN
        DELETE FROM customer_credentials WHERE workspace_id = OLD.workspace_id AND contact_id = OLD.id;
        DELETE FROM customer_password_resets WHERE workspace_id = OLD.workspace_id AND contact_id = OLD.id;
        DELETE FROM customer_sessions WHERE workspace_id = OLD.workspace_id AND contact_id = OLD.id;
        DELETE FROM customer_oidc_identities WHERE workspace_id = OLD.workspace_id AND contact_id = OLD.id AND revoked_at IS NULL;
        IF FOUND THEN
            UPDATE contacts SET customer_oidc_relink_required = true WHERE workspace_id = OLD.workspace_id AND id = OLD.id;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
