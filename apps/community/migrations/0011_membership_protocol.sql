ALTER TABLE pending_admissions
  ADD COLUMN account_id text,
  ADD COLUMN bound_at timestamptz,
  ADD COLUMN consumed_at timestamptz;

ALTER TABLE pending_admissions ADD CONSTRAINT pending_admissions_binding_shape CHECK (
  (account_id IS NULL AND bound_at IS NULL) OR
  (account_id IS NOT NULL AND bound_at IS NOT NULL)
);
CREATE UNIQUE INDEX pending_admissions_community_id_unique
  ON pending_admissions(community_id, id);

CREATE TABLE admission_receipts (
  admission_id uuid PRIMARY KEY REFERENCES pending_admissions(id) ON DELETE CASCADE,
  community_id uuid NOT NULL REFERENCES communities(id),
  invite_id uuid NOT NULL REFERENCES invites(id),
  account_id text NOT NULL,
  member_id uuid NOT NULL REFERENCES members(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT admission_receipts_admission_tenant_fk
    FOREIGN KEY (community_id, admission_id)
    REFERENCES pending_admissions(community_id, id),
  CONSTRAINT admission_receipts_invite_tenant_fk
    FOREIGN KEY (community_id, invite_id)
    REFERENCES invites(community_id, id),
  CONSTRAINT admission_receipts_member_tenant_fk
    FOREIGN KEY (community_id, member_id)
    REFERENCES members(community_id, id)
);

CREATE INDEX admission_receipts_community_idx ON admission_receipts(community_id);
CREATE UNIQUE INDEX admission_receipts_account_admission_unique
  ON admission_receipts(admission_id, account_id);
