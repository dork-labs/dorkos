import { browserViewerInputSchema } from '@dorkos/shared/browser-viewer-control';

export type ViewerInputMethod =
  | 'Input.dispatchMouseEvent'
  | 'Input.dispatchKeyEvent'
  | 'Input.dispatchTouchEvent'
  | 'Input.insertText'
  | 'Input.imeSetComposition';

interface InputProtocol {
  send(method: ViewerInputMethod, params: Record<string, unknown>): Promise<unknown>;
}
/** Pure closed projection, used only inside the broker's private person-input channel. */
export async function dispatchViewerInput(
  protocol: InputProtocol,
  value: unknown,
  heldButtons = 0
): Promise<void> {
  const input = browserViewerInputSchema.parse(value);
  switch (input.kind) {
    case 'pointer': {
      const { kind: _kind, ...params } = input;
      await protocol.send('Input.dispatchMouseEvent', { ...params, buttons: heldButtons });
      break;
    }
    case 'wheel': {
      const { kind: _kind, ...params } = input;
      await protocol.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        ...params,
        buttons: heldButtons,
      });
      break;
    }
    case 'key': {
      const { kind: _kind, ...params } = input;
      await protocol.send('Input.dispatchKeyEvent', params);
      break;
    }
    case 'touch':
      await protocol.send('Input.dispatchTouchEvent', {
        type: input.type,
        touchPoints: input.points,
      });
      break;
    case 'text':
      await protocol.send('Input.insertText', { text: input.text });
      break;
    case 'composition':
      if (input.selectionStart > input.selectionEnd || input.selectionEnd > input.text.length)
        throw Error('viewer_bad_request');
      await protocol.send('Input.imeSetComposition', {
        text: input.text,
        selectionStart: input.selectionStart,
        selectionEnd: input.selectionEnd,
      });
  }
}
