import { DocChannelNotFoundError } from '../authorization.js';
import type { OriginalHttpRequestCustody } from './http-composition-contracts.js';
import type { OriginalHttpPrincipalMembershipView } from './http-principal-membership.js';

/** Read or refuse the supplied original request custody map without registering an owner. */
export function selectOriginalHttpRequestCustody(
  owner: object,
  httpCustodyViews: WeakMap<object, OriginalHttpRequestCustody>,
  httpCustodyApply: typeof Reflect.apply,
  httpCustodyGet: typeof WeakMap.prototype.get
): OriginalHttpRequestCustody {
  const view = httpCustodyApply(httpCustodyGet, httpCustodyViews, [owner]) as
    OriginalHttpRequestCustody | undefined;
  if (!view) throw new DocChannelNotFoundError();
  return view;
}

/** Read or refuse the supplied original principal membership map without registering an owner. */
export function selectOriginalHttpPrincipalMembership(
  owner: object,
  httpPrincipalMembershipViews: WeakMap<object, OriginalHttpPrincipalMembershipView>,
  httpCustodyApply: typeof Reflect.apply,
  httpCustodyGet: typeof WeakMap.prototype.get
): OriginalHttpPrincipalMembershipView {
  const view: OriginalHttpPrincipalMembershipView | undefined = httpCustodyApply(
    httpCustodyGet,
    httpPrincipalMembershipViews,
    [owner]
  );
  if (!view) throw new DocChannelNotFoundError();
  return view;
}
