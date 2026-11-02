-- HAND-WRITTEN data migration (DOR-3440). A turn now runs at its agent's set
-- level, wherever its message came from, so holds written by the old rules go.
--
-- A chat's held last turn: no follow-on turn is held for it. Only a Wi-Fi
-- sign-in's or a teammate's turn writes this from here on.
UPDATE `session_metadata` SET `last_turn_held` = 0 WHERE `last_turn_held` = 1;
--> statement-breakpoint
-- Queue rows an extension or the web relay sent. A Wi-Fi sign-in's row stays held.
UPDATE `session_message_queue` SET `held_to_default` = 0
  WHERE `held_to_default` = 1 AND (`client_id` LIKE 'extension:%' OR `client_id` LIKE 'relay:%');
