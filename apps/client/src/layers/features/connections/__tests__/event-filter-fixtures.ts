/** Synthetic values matching the observed Gmail scalar/annotation shape, not captured live defaults. */
export const gmailFilterSchema = {
  type: 'object',
  properties: {
    interval: { type: 'number', title: 'Interval', default: 1.5 },
    labelIds: {
      type: 'string',
      title: 'Labels',
      default: 'INBOX',
      examples: ['SENT', 'STARRED', 'DRAFT'],
    },
    query: {
      type: 'string',
      title: 'Query',
      default: '',
      examples: ['is:unread', 'has:attachment', 'from:sender@example.test'],
    },
    userId: { type: 'string', title: 'User', default: 'me', examples: ['reader@example.test'] },
  },
};
