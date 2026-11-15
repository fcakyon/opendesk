DROP TRIGGER IF EXISTS contacts_email_free ON contacts;
DROP FUNCTION IF EXISTS contact_email_primary_free();
DROP TRIGGER IF EXISTS contact_emails_free ON contact_emails;
DROP FUNCTION IF EXISTS contact_email_extra_free();
DROP TABLE IF EXISTS contact_emails;
