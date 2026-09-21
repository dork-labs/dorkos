-- Recovery history must survive deleting the second community. It is deliberately
-- not a foreign key: deleting a tenant must not erase the first tenant's identity.
CREATE TABLE community_backout_fence (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  first_community_id uuid,
  multiple_communities_used boolean NOT NULL DEFAULT false
);
INSERT INTO community_backout_fence(first_community_id,multiple_communities_used)
SELECT (array_agg(id ORDER BY id))[1],count(*) > 1 FROM communities;

CREATE FUNCTION preserve_community_backout_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'community recovery history cannot be removed';
  END IF;
  IF (OLD.multiple_communities_used AND NOT NEW.multiple_communities_used)
     OR (OLD.first_community_id IS NOT NULL AND
         NEW.first_community_id IS DISTINCT FROM OLD.first_community_id) THEN
    RAISE EXCEPTION 'community recovery history cannot be reset';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_community_backout_fence_row
BEFORE UPDATE OR DELETE ON community_backout_fence
FOR EACH ROW EXECUTE FUNCTION preserve_community_backout_fence();
CREATE TRIGGER preserve_community_backout_fence_truncate
BEFORE TRUNCATE ON community_backout_fence
FOR EACH STATEMENT EXECUTE FUNCTION preserve_community_backout_fence();

CREATE FUNCTION record_community_backout_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- One row serializes concurrent INSERTs. The expression uses the latest locked
  -- tuple, not a count from an INSERT statement's potentially stale snapshot.
  UPDATE community_backout_fence
  SET multiple_communities_used = multiple_communities_used
        OR (first_community_id IS NOT NULL AND first_community_id <> NEW.id),
      first_community_id = COALESCE(first_community_id,NEW.id)
  WHERE singleton;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'community recovery history is unavailable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER record_community_backout_history
BEFORE INSERT ON communities
FOR EACH ROW EXECUTE FUNCTION record_community_backout_history();
