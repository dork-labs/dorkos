CREATE TABLE entry_mentions (
  entry_id uuid NOT NULL,
  position integer NOT NULL CHECK (position > 0),
  community_id uuid NOT NULL REFERENCES communities(id),
  mentioned_member_id uuid,
  mentioned_agent_id uuid,
  PRIMARY KEY(entry_id,position),
  CONSTRAINT entry_mentions_exactly_one_target CHECK (
    (mentioned_member_id IS NULL) <> (mentioned_agent_id IS NULL)
  ),
  CONSTRAINT entry_mentions_entry_tenant_fk FOREIGN KEY(community_id,entry_id)
    REFERENCES entries(community_id,id) ON DELETE CASCADE,
  CONSTRAINT entry_mentions_member_tenant_fk FOREIGN KEY(community_id,mentioned_member_id)
    REFERENCES members(community_id,id),
  CONSTRAINT entry_mentions_agent_tenant_fk FOREIGN KEY(community_id,mentioned_agent_id)
    REFERENCES agents(community_id,id)
);
CREATE INDEX entry_mentions_member_idx ON entry_mentions(community_id,mentioned_member_id);
CREATE INDEX entry_mentions_agent_idx ON entry_mentions(community_id,mentioned_agent_id);

CREATE TABLE export_archive_channels (
  export_archive_id uuid NOT NULL,
  position integer NOT NULL CHECK (position > 0),
  community_id uuid NOT NULL REFERENCES communities(id),
  channel_id uuid NOT NULL,
  PRIMARY KEY(export_archive_id,position),
  CONSTRAINT export_archive_channels_archive_tenant_fk
    FOREIGN KEY(community_id,export_archive_id)
    REFERENCES export_archives(community_id,id) ON DELETE CASCADE,
  CONSTRAINT export_archive_channels_channel_tenant_fk FOREIGN KEY(community_id,channel_id)
    REFERENCES channels(community_id,id)
);
CREATE INDEX export_archive_channels_channel_idx
ON export_archive_channels(community_id,channel_id);

DO $$
DECLARE
  invalid_mentions bigint;
  invalid_channels bigint;
BEGIN
  SELECT count(*) INTO invalid_mentions
  FROM entries e
  CROSS JOIN LATERAL unnest(e.mentions) WITH ORDINALITY AS mention(target_id,position)
  LEFT JOIN members m ON m.community_id=e.community_id AND m.id=mention.target_id
  LEFT JOIN agents a ON a.community_id=e.community_id AND a.id=mention.target_id
  WHERE (m.id IS NULL) = (a.id IS NULL);
  IF invalid_mentions > 0 THEN
    RAISE EXCEPTION 'tenant relation backfill found unresolved or ambiguous entry mentions';
  END IF;

  SELECT count(*) INTO invalid_channels
  FROM export_archives archive
  CROSS JOIN LATERAL unnest(archive.channel_ids) WITH ORDINALITY AS selected(channel_id,position)
  LEFT JOIN channels channel
    ON channel.community_id=archive.community_id AND channel.id=selected.channel_id
  WHERE channel.id IS NULL;
  IF invalid_channels > 0 THEN
    RAISE EXCEPTION 'tenant relation backfill found unresolved export channels';
  END IF;
END $$;

INSERT INTO entry_mentions(
  entry_id,position,community_id,mentioned_member_id,mentioned_agent_id
)
SELECT e.id,mention.position,e.community_id,m.id,a.id
FROM entries e
CROSS JOIN LATERAL unnest(e.mentions) WITH ORDINALITY AS mention(target_id,position)
LEFT JOIN members m ON m.community_id=e.community_id AND m.id=mention.target_id
LEFT JOIN agents a ON a.community_id=e.community_id AND a.id=mention.target_id;

INSERT INTO export_archive_channels(export_archive_id,position,community_id,channel_id)
SELECT archive.id,selected.position,archive.community_id,selected.channel_id
FROM export_archives archive
CROSS JOIN LATERAL unnest(archive.channel_ids) WITH ORDINALITY AS selected(channel_id,position);

CREATE FUNCTION sync_entry_mentions_from_array() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM entry_mentions WHERE entry_id=NEW.id;
  INSERT INTO entry_mentions(
    entry_id,position,community_id,mentioned_member_id,mentioned_agent_id
  )
  SELECT NEW.id,mention.position,NEW.community_id,m.id,a.id
  FROM unnest(NEW.mentions) WITH ORDINALITY AS mention(target_id,position)
  LEFT JOIN members m ON m.community_id=NEW.community_id AND m.id=mention.target_id
  LEFT JOIN agents a ON a.community_id=NEW.community_id AND a.id=mention.target_id;
  RETURN NEW;
END $$;

CREATE TRIGGER entries_sync_mentions
AFTER INSERT OR UPDATE OF mentions,community_id ON entries
FOR EACH ROW EXECUTE FUNCTION sync_entry_mentions_from_array();

CREATE FUNCTION sync_export_channels_from_array() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM export_archive_channels WHERE export_archive_id=NEW.id;
  INSERT INTO export_archive_channels(export_archive_id,position,community_id,channel_id)
  SELECT NEW.id,selected.position,NEW.community_id,selected.channel_id
  FROM unnest(NEW.channel_ids) WITH ORDINALITY AS selected(channel_id,position);
  RETURN NEW;
END $$;

CREATE TRIGGER export_archives_sync_channels
AFTER INSERT OR UPDATE OF channel_ids,community_id ON export_archives
FOR EACH ROW EXECUTE FUNCTION sync_export_channels_from_array();
