-- The date an owner-replacement notice promised the owner (specs/community-owner-replacement,
-- "Which wait applies"; DOR-2540). Each send of the notice tells the owner the earliest date the
-- new owner could take over: that send's time plus the wait the notice would get if the mail
-- server took it then. The stored date is counted later, from when the mail server answered,
-- with the settings in force then. If a host lowers COMMUNITY_OWNER_REPLACEMENT_NOTICE_DAYS or
-- COMMUNITY_OWNER_REPLACEMENT_UNREACHABLE_DAYS in between, the counted date could fall before
-- the one the owner was told. So each send records the latest date promised so far, and the
-- stored date is never earlier than it.
--
-- Not personal data: a date. No foreign key, no index (it is read only with its own row).
--
-- Backout: revert the code. Code that predates this migration ignores the column. This migration
-- stays applied.

ALTER TABLE owner_replacements
  ADD COLUMN notice_promised_at timestamptz;
