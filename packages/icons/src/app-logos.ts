/**
 * The marks of the popular apps DorkOS always lists, keyed by service id, as
 * image URLs the client's build serves itself (connection-app-details §2).
 *
 * Each file is the brand's mark, unaltered; `app-logos/README.md` records where
 * every file came from. These are other companies' trademarks, shown only to
 * identify their apps, and do not imply endorsement.
 *
 * @module icons/app-logos
 */
import airtable from './app-logos/airtable.png?url';
import asana from './app-logos/asana.svg?url';
import dropbox from './app-logos/dropbox.svg?url';
import github from './app-logos/github.svg?url';
import gmail from './app-logos/gmail.svg?url';
import googlecalendar from './app-logos/googlecalendar.svg?url';
import googledocs from './app-logos/googledocs.svg?url';
import googledrive from './app-logos/googledrive.svg?url';
import googlesheets from './app-logos/googlesheets.svg?url';
import hubspot from './app-logos/hubspot.png?url';
import jira from './app-logos/jira.svg?url';
import linear from './app-logos/linear.svg?url';
import notion from './app-logos/notion.png?url';
import outlook from './app-logos/outlook.svg?url';
import slack from './app-logos/slack.svg?url';
import telegram from './app-logos/telegram.svg?url';
import todoist from './app-logos/todoist.svg?url';

/**
 * Service id to the app's bundled mark. The ids are the catalog's service ids
 * (Composio toolkit slugs, and the chat apps' Relay adapter types).
 */
export const APP_LOGO_MAP: Readonly<Record<string, string>> = {
  airtable,
  asana,
  dropbox,
  github,
  gmail,
  googlecalendar,
  googledocs,
  googledrive,
  googlesheets,
  hubspot,
  jira,
  linear,
  notion,
  outlook,
  slack,
  telegram,
  todoist,
};
