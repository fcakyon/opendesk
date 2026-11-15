-- Mail a help desk marks automatic (Auto-Submitted, Precedence: bulk) is taken in as any mail
-- instead of dropped, with nothing automatic answering it (contracts/api.md "Inbound email").
ALTER TABLE mailboxes ADD COLUMN keep_automatic_mail boolean NOT NULL DEFAULT false;
