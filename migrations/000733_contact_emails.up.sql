-- Extra email addresses of a contact, beside its primary one (contacts.email). Mail from any of
-- them lands on the same contact. An address belongs to one contact in a workspace, whether it
-- is a primary or an extra: the triggers below hold that for every writer, and answer with the
-- unique violation the contacts API already turns into a 409.
CREATE TABLE contact_emails (
    workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    contact_id   uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    email        citext NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, email)
);
CREATE INDEX contact_emails_contact_idx ON contact_emails (contact_id);

CREATE FUNCTION contact_email_extra_free() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id::text || ':' || lower(NEW.email::text), 0));
    IF EXISTS (SELECT 1 FROM contacts WHERE workspace_id = NEW.workspace_id AND email = NEW.email) THEN
        RAISE EXCEPTION 'this address belongs to a contact already' USING ERRCODE = '23505', CONSTRAINT = 'contacts_ws_email_uq';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER contact_emails_free BEFORE INSERT OR UPDATE OF email ON contact_emails
    FOR EACH ROW EXECUTE FUNCTION contact_email_extra_free();

CREATE FUNCTION contact_email_primary_free() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.email IS NULL THEN
        RETURN NEW;
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(NEW.workspace_id::text || ':' || lower(NEW.email::text), 0));
    IF EXISTS (SELECT 1 FROM contact_emails WHERE workspace_id = NEW.workspace_id AND email = NEW.email) THEN
        RAISE EXCEPTION 'this address belongs to a contact already' USING ERRCODE = '23505', CONSTRAINT = 'contacts_ws_email_uq';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER contacts_email_free BEFORE INSERT OR UPDATE OF email ON contacts
    FOR EACH ROW EXECUTE FUNCTION contact_email_primary_free();
