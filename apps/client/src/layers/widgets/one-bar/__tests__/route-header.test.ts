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
    ).toEqual({ key: expect.any(String), Header: HomeBar });
  });

  it('gives routes that share a bar the SAME cross-fade key', () => {
    // The whole point of keying on the component. `/`, `/activity`, `/tasks`
    // and `/workspaces` all declare `HomeSurfaceBar`; keyed by route id they
    // were four keys, so `AnimatePresence` tore the bar down and built it again
    // on every tab press — the strip lost its scroll position, the sliding
    // underline had nothing to slide from, and the row blinked.
    const keyOf = (routeId: string) =>
      resolveRouteHeader([
        { routeId: '_shell', staticData: { header: null } },
        { routeId, staticData: { header: HomeBar } },
      ])?.key;

    expect(keyOf('/')).toBe(keyOf('/activity'));
    expect(keyOf('/tasks')).toBe(keyOf('/workspaces'));
    expect(keyOf('/')).toBe(keyOf('/tasks'));
  });

  it('still gives DIFFERENT bars different keys, so unrelated routes cross-fade', () => {
    // The other half: `/channels` → `/team` must still animate. A key shared by
    // two different bars would swap one for the other with no transition at all
    // — and would be the DOR-587 "wrong bar on screen" failure wearing a new hat.
    const home = resolveRouteHeader([{ routeId: '/', staticData: { header: HomeBar } }]);
    const channels = resolveRouteHeader([
      { routeId: '/channels', staticData: { header: ChannelsBar } },
    ]);

    expect(home?.key).not.toBe(channels?.key);
  });

  it('answers the same key for the same bar every time it is asked', () => {
    // Stability across calls, not just within one: the key is read on every
    // render, and one that changed per call would remount the bar continuously.
    const first = resolveRouteHeader([{ routeId: '/', staticData: { header: ChannelsBar } }])?.key;
    const second = resolveRouteHeader([{ routeId: '/', staticData: { header: ChannelsBar } }])?.key;

    expect(first).toBe(second);
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
