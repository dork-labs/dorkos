import { LIMITS } from './contracts.mjs';
import { BrowserManagerError } from './manager-error.mjs';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Dispatch one input after the manager's abort check; control owns serialization/epochs. */
export async function dispatchManagedInput(tab, action, allowedUrl) {
  const page = tab.page;
  if (!action || Buffer.byteLength(JSON.stringify(action)) > LIMITS.maxActionBytes)
    throw new BrowserManagerError('INVALID_ACTION');
  const point = () => {
    if (
      !Number.isFinite(action.x) ||
      !Number.isFinite(action.y) ||
      action.x < 0 ||
      action.y < 0 ||
      action.x >= tab.viewport.width ||
      action.y >= tab.viewport.height
    )
      throw new BrowserManagerError('INVALID_COORDINATES');
  };
  const button = action.button ?? 'left';
  const key = () => {
    if (typeof action.key !== 'string' || action.key.length < 1 || action.key.length > 64)
      throw new BrowserManagerError('INVALID_KEY');
  };
  const text = () => {
    if (typeof action.text !== 'string' || action.text.length > 2048)
      throw new BrowserManagerError('INVALID_TEXT');
  };
  switch (action.type) {
    case 'mouseMove':
      point();
      return page.mouse.move(action.x, action.y);
    case 'mouseDown':
      if (!['left', 'right', 'middle'].includes(button))
        throw new BrowserManagerError('INVALID_BUTTON');
      tab.buttons.add(button);
      return page.mouse.down({ button });
    case 'mouseUp':
      if (!['left', 'right', 'middle'].includes(button))
        throw new BrowserManagerError('INVALID_BUTTON');
      await page.mouse.up({ button });
      tab.buttons.delete(button);
      return;
    case 'click':
      point();
      if (!['left', 'right', 'middle'].includes(button))
        throw new BrowserManagerError('INVALID_BUTTON');
      tab.buttons.add(button);
      await page.mouse.click(action.x, action.y, { button });
      tab.buttons.delete(button);
      return;
    case 'wheel':
      if (
        !Number.isFinite(action.deltaX) ||
        !Number.isFinite(action.deltaY) ||
        Math.abs(action.deltaX) > 10000 ||
        Math.abs(action.deltaY) > 10000
      )
        throw new BrowserManagerError('INVALID_WHEEL');
      return page.mouse.wheel(action.deltaX, action.deltaY);
    case 'touch':
      point();
      tab.cdp ??= await page.context().newCDPSession(page);
      tab.touchActive = true;
      await tab.cdp.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: action.x, y: action.y }],
      });
      await tab.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      tab.touchActive = false;
      return;
    case 'keyDown':
      key();
      tab.keys.add(action.key);
      return page.keyboard.down(action.key);
    case 'keyUp':
      key();
      await page.keyboard.up(action.key);
      tab.keys.delete(action.key);
      return;
    case 'text':
      text();
      return page.keyboard.insertText(action.text);
    case 'navigate': {
      if (!allowedUrl(action.url)) throw new BrowserManagerError('INVALID_URL');
      const url = new URL(action.url);
      return page.goto(url.href);
    }
    case 'wait':
      if (!Number.isSafeInteger(action.ms) || action.ms < 0 || action.ms > 1500)
        throw new BrowserManagerError('INVALID_WAIT');
      return delay(action.ms);
    case 'composition':
      text();
      tab.cdp ??= await page.context().newCDPSession(page);
      tab.composition = true;
      return tab.cdp.send('Input.imeSetComposition', {
        text: action.text,
        selectionStart: action.selectionStart ?? action.text.length,
        selectionEnd: action.selectionEnd ?? action.text.length,
      });
    case 'compositionCommit':
      text();
      tab.cdp ??= await page.context().newCDPSession(page);
      await tab.cdp.send('Input.insertText', { text: action.text });
      tab.composition = false;
      return;
    default:
      throw new BrowserManagerError('INVALID_ACTION');
  }
}

/** Release tracked held input after the control queue barrier, before granting input. */
export async function resetManagedInput(tab) {
  for (const button of tab.buttons) {
    await tab.page.mouse.up({ button });
    tab.buttons.delete(button);
  }
  for (const key of tab.keys) {
    await tab.page.keyboard.up(key);
    tab.keys.delete(key);
  }
  if (tab.touchActive) {
    await tab.cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    tab.touchActive = false;
  }
  if (tab.composition) {
    await tab.cdp.send('Input.imeSetComposition', {
      text: '',
      selectionStart: 0,
      selectionEnd: 0,
    });
    tab.composition = false;
  }
}
