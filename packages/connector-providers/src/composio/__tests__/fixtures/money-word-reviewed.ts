/**
 * Money-word matches reviewed as not moving money (DOR-4624), each with why,
 * against the 2026-11-18 catalog in `money-word-candidates.json`. Exact
 * Composio slugs only, so a new action of the same app is reviewed on its
 * own. An action that charges, pays, transfers funds, buys or issues
 * spendable value never gets a reason here: it needs a pin in
 * `action-classes.ts`, and Security rules on each one.
 */
export const MONEY_WORD_REVIEWED: Readonly<Record<string, string>> = {
  ALLMODELS_CREATE_TOP_UP_LINK:
    'makes a checkout link; a person pays outside DorkOS, and AllModels is on the paid list',
  AMPLITUDE_MCP_QUERY_AMPLITUDE_DATA:
    'analytics queries and charts; "purchase" is an example event',
  AMPLITUDE_MCP_UPDATE_PROPERTIES: 'edits tracking-plan property labels',
  API_NINJAS_CALCULATE_SALES_TAX: 'calculates the tax on an amount; moves no money',
  BENCHMARK_EMAIL_POST_ASSIGN_PRODUCT_LIST: 'links a Shopify product to an email list',
  BITLY_ADD_CUSTOM_DOMAIN: 'adds a domain the person already owns; it says it buys none',
  BRAZE_TRACK_USERS: 'records profile data, events and purchases as analytics; moves no money',
  DEPUTY_POST_MY_ROSTER_BY_ID_SWAP_BY_ACTION: 'a shift swap between staff',
  ELEVENLABS_ADD_OUTBOUND_PHONE_NUMBER:
    'imports a number the person already has; it says it buys none',
  ESPUTNIK_GENERATE_EVENT_V3: 'records a contact event for marketing automation',
  FARADAY_CREATE_OUTCOME: 'creates a prediction model; a purchase is what it predicts',
  FLY_ADD_WIRE_GUARD_PEER: 'adds a WireGuard network peer; "wire" is the VPN',
  GOSQUARED_TRACKING_EVENT: 'records an analytics event',
  GOSQUARED_TRACKING_TRANSACTION: 'records a finished sale in analytics; moves no money',
  GUSTO_ADD_EMPLOYEES_TO_HOLIDAY_PAY_POLICY: 'a holiday pay policy setting, not a payroll run',
  GUSTO_ASSIGN_PAY_SCHEDULES: 'sets which pay schedule employees follow, not a payroll run',
  GUSTO_CREATE_HOLIDAY_PAY_POLICY: 'a holiday pay policy setting, not a payroll run',
  GUSTO_CREATE_PAY_SCHEDULES_ASSIGNMENT_PREVIEW: 'previews pay schedule changes; applies nothing',
  GUSTO_LIST_PAY_SCHEDULES_PREVIEW: 'previews pay dates; applies nothing',
  GUSTO_UPDATE_HOLIDAY_PAY_POLICY: 'a holiday pay policy setting, not a payroll run',
  HARVEY_CREATE_ASSISTANT_COMPLETION:
    'one assistant reply; the purchase it names is a plan requirement',
  JIBBLE_CHANGE_PAY_PERIOD_STATUS:
    'approves or reopens a timesheet period; Jibble tracks time, pays no one',
  LEXOFFICE_CREATE_VOUCHER: 'a bookkeeping record of a receipt or invoice; moves no money',
  LOYVERSE_CREATE_OR_UPDATE_SUPPLIER: 'a supplier record',
  MAGIC_HOUR_CREATE_BODY_SWAP:
    'an image job billed in Magic Hour credits; the app is on the paid list',
  MAGIC_HOUR_CREATE_FACE_SWAP_PHOTO:
    'an image job billed in Magic Hour credits; the app is on the paid list',
  MAGIC_HOUR_CREATE_FACE_SWAP_VIDEO:
    'a video job billed in Magic Hour credits; the app is on the paid list',
  MAGIC_HOUR_CREATE_HEAD_SWAP:
    'an image job billed in Magic Hour credits; the app is on the paid list',
  MAILCHIMP_ADD_EVENT: 'records a contact event; "purchase" is an example',
  MAILERLITE_CREATE_ECOMMERCE_CUSTOMER: 'a shop customer record',
  MOCO_PATCH_TAGGINGS: 'adds tags to a record; "Purchase" is a record type',
  MOCO_UPDATE_TAGGINGS: 'replaces tags on a record; "Purchase" is a record type',
  MSG91_CREATE_USER_EVENTS: 'records a user event for segments',
  RILLET_CREATE_A_PRODUCT: 'a product catalog entry; bills no one',
  SAPERLY_PLACE_CALL: 'a call billed per minute; Saperly is on the paid list',
  SAPERLY_SEND_SMS: 'a text billed per segment; Saperly is on the paid list',
  TICKET_TAILOR_MCP_PRODUCT_CREATE: 'a product listing customers can buy; charges no one',
  WHATSAPP_ADD_BUSINESS_PHONE_NUMBER: 'adds a verified number to partner stock; buys nothing',
  WHATSAPP_UPDATE_COMMERCE_SETTINGS: 'turns the shop cart or catalog on or off',
  ZOHO_INVENTORY_ADD_CREDIT_NOTE_COMMENT: 'a comment on a credit note',
};
