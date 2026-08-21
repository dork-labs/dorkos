import { describe, it, expect } from 'vitest';
import { resolveRouteHeader } from '../model/route-header';

const HomeBar = () => null;
const ChannelsBar = () => null;

describe('resolveRouteHeader', () => {
  it('takes the leaf route‘s bar, not a layout ancestor‘s', () => {
    // `/` is a leaf under the `_home` layout route. The layout declares no bar,
    // so a root-first search would have found nothing and the home surface would
    // have rendered with an empty header.
    expect(
      resolveRouteHeader([
        { routeId: '__root__', staticData: { header: null } },
        { routeId: '_shell', staticData: { header: null } },
        { routeId: '_home', staticData: { header: null } },
        { routeId: '/', staticData: { header: HomeBar } },
      ])
    ).toEqual({ key: '/', Header: HomeBar });
  });

  it('names the owning route as the cross-fade key', () => {
    const resolved = resolveRouteHeader([
      { routeId: '_shell', staticData: { header: null } },
      { routeId: '/channels', staticData: { header: ChannelsBar } },
    ]);
    expect(resolved?.key).toBe('/channels');
  });

  it('answers null when nothing in the chain declares a bar', () => {
    // The shell renders no header row content at all rather than falling back to
    // some other route's — the fallback was the DOR-587 defect.
    expect(
      resolveRouteHeader([
        { routeId: '__root__', staticData: { header: null } },
        { routeId: '/agents', staticData: { header: null } },
      ])
    ).toBeNull();
  });

  it('answers null for an empty chain', () => {
    expect(resolveRouteHeader([])).toBeNull();
  });
});
