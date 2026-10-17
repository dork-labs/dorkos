import { describe, expect, it } from 'vitest';
import {
  classifyDevtoolsFrameChange,
  type DevtoolsFrameContext,
} from '../model/devtools-frame-boundary';

function observed(): DevtoolsFrameContext {
  return {
    frame: window,
    sessionId: 'chat-a',
    documentId: 'doc-a',
    logicalUrl: '/page.html',
    source: '/signed/a',
    eligibility: 'served-document',
    origin: null,
    reload: 0,
  };
}

describe('host-observed DevTools retirement boundary', () => {
  it('the first observation is a physical boundary rather than a retained Doc load', () => {
    expect(classifyDevtoolsFrameChange(null, observed())).toEqual({
      changed: true,
      pageChanged: true,
      sessionOnlyChanged: false,
    });
  });
  it('the same complete host context causes no retirement', () => {
    const previous = observed();
    expect(classifyDevtoolsFrameChange(previous, { ...previous })).toEqual({
      changed: false,
      pageChanged: false,
      sessionOnlyChanged: true,
    });
  });
  it('only chat attribution may change without retiring the sibling Doc load', () => {
    const previous = observed();
    expect(classifyDevtoolsFrameChange(previous, { ...previous, sessionId: 'chat-b' })).toEqual({
      changed: true,
      pageChanged: false,
      sessionOnlyChanged: true,
    });
  });
  it('a replaced physical Window requires retirement even at the same URL', () => {
    const previous = observed();
    const iframe = document.createElement('iframe');
    document.body.append(iframe);
    try {
      expect(iframe.contentWindow).not.toBe(previous.frame);
      expect(
        classifyDevtoolsFrameChange(previous, { ...previous, frame: iframe.contentWindow })
      ).toEqual({ changed: true, pageChanged: true, sessionOnlyChanged: false });
    } finally {
      iframe.remove();
    }
  });
  it('every document, source, URL and reload boundary retires the old Doc load', () => {
    const previous = observed();
    for (const update of [
      { documentId: 'doc-b' },
      { source: '/signed/b' },
      { logicalUrl: '/other.html' },
      { reload: 1 },
    ]) {
      expect(classifyDevtoolsFrameChange(previous, { ...previous, ...update })).toEqual({
        changed: true,
        pageChanged: true,
        sessionOnlyChanged: false,
      });
    }
  });
  it('origin and eligibility changes cannot use the attribution-only exception', () => {
    const previous = observed();
    for (const update of [{ origin: 'https://different.invalid' }, { eligibility: null }]) {
      expect(classifyDevtoolsFrameChange(previous, { ...previous, ...update })).toEqual({
        changed: true,
        pageChanged: false,
        sessionOnlyChanged: false,
      });
    }
  });
});
