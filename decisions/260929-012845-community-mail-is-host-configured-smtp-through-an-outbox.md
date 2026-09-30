---
id: 260929-012845
title: The Community server sends mail only when a host configures SMTP, through a durable outbox that stores no address
status: accepted
created: 2026-09-28
spec: community-owner-replacement
superseded-by: null
amends: null
---

# 260929-012845. The Community server sends mail only when a host configures SMTP, through a durable outbox that stores no address

## Status

Accepted (from spec `community-owner-replacement`, DOR-2252). Shipped in DOR-2537 (#2322): `apps/community/src/mail/`, `notice_outbox`, and the SMTP settings in `apps/community/src/config.ts`.

## Context

The Community server has never sent email: accounts are identified by address, password recovery is done offline by the operator, and every notice is shown in the product. Replacing an owner who has left needs notice that reaches a person who no longer opens the community. The options were SMTP configured by the host, a signed webhook the host turns into mail, or in-product notice only.

## Decision

We will add optional outbound mail over SMTP, off unless a host sets `COMMUNITY_SMTP_URL` and `COMMUNITY_MAIL_FROM`, using `nodemailer`, with TLS required off loopback. Messages are queued in a `notice_outbox` table in the same transaction as the event that causes them and sent by a worker outside any transaction. The outbox stores the recipient's account id, never the address, and records only an error class, never the server's reply; a recipient whose account is gone or being erased fails without sending. A message never carries a claim or sign-in credential. The one secret it may carry is an object-only link for owner replacement: a token that can only keep the status quo, minted per send attempt, stored as a hash, never deleted when an attempt fails (a timeout may still have delivered it), single use, and dead when its request closes. A message is "accepted" when the SMTP server returns `2xx`; that is the most the product ever claims. Features that depend on real notice, starting with owner replacement, refuse to run when mail is off.

## Consequences

### Positive

- Every mail service and every self-hosting operator can supply SMTP; a hosted service points it at its own provider.
- Hosts that set nothing keep today's behaviour exactly: no mail, no new outbound connection.
- Erasing an account leaves no address behind in the outbox.
- An owner who can no longer sign in can still answer a notice, because the only secret in the mail is one that can do nothing but object.

### Negative

- A new runtime dependency and a new outbound connection to secure and operate.
- Delivery is only as good as the host's mail setup; a sender domain without aligned SPF, DKIM, and DMARC shows up as failed notices and longer waits.
- A forwarded or shared mailbox can use the object-only link; that can only keep things as they are.
- Other notices (host deletion, takedown) may now be asked to use mail; each needs its own decision so mail does not spread by default.
