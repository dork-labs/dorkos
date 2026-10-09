import {
  BrowserInputStepSchema,
  type BrowserBinding,
  type BrowserControl,
  type BrowserViewer,
  type BrowserInputStep,
} from '@dorkos/shared/browser-schemas';

interface EditableContext {
  readonly controller: BrowserControl;
  readonly viewer: BrowserViewer;
}
interface EditableScope {
  readonly controllerId: string;
  readonly viewerId: string;
  readonly binding: BrowserBinding;
}
interface EditablePort<Context extends EditableContext> {
  readonly context: () => Context;
  readonly closed: () => boolean;
  readonly composing: () => boolean;
  readonly updateComposition: () => void;
  readonly cancelGesture: () => void;
  readonly stale: () => Error;
  readonly issue: (context: Context, steps: BrowserInputStep[], consume: () => void) => void;
}
const same = (a: BrowserBinding, b: BrowserBinding) =>
  (Object.keys(a) as (keyof BrowserBinding)[]).every((key) => a[key] === b[key]);

/** Owned editable receiver state. It has no native producer or clipboard API of its own. */
export class CanvasEditableInput<Context extends EditableContext> {
  private readonly defer = queueMicrotask.bind(globalThis);
  private editable?: EditableScope;
  private edit?: { inputType: string; data: string | null; scope: EditableScope };
  private compositionTail?: { text: string; scope: EditableScope };
  constructor(
    private readonly ime: HTMLTextAreaElement,
    private readonly port: EditablePort<Context>
  ) {}
  close(): void {
    this.editable = undefined;
    this.edit = undefined;
    this.compositionTail = undefined;
    this.ime.value = '';
  }
  committed(text: string, context: Context): void {
    const tail = {
      text,
      scope: {
        controllerId: context.controller.controllerId!,
        viewerId: context.viewer.viewerId,
        binding: context.controller.binding,
      },
    };
    this.compositionTail = tail;
    this.defer(() => {
      if (this.compositionTail === tail) this.compositionTail = undefined;
    });
  }
  capture(): void {
    this.edit = undefined;
    this.compositionTail = undefined;
    this.ime.value = '';
    try {
      const context = this.port.context();
      this.editable = {
        controllerId: context.controller.controllerId!,
        viewerId: context.viewer.viewerId,
        binding: context.controller.binding,
      };
    } catch {
      this.editable = undefined;
    }
  }
  context(scope = this.editable) {
    const context = this.port.context();
    if (
      !scope ||
      this.ime.ownerDocument.activeElement !== this.ime ||
      scope.controllerId !== context.controller.controllerId ||
      scope.viewerId !== context.viewer.viewerId ||
      !same(scope.binding, context.controller.binding)
    )
      throw this.port.stale();
    return context;
  }
  private swallowCompositionTail(event: InputEvent): boolean {
    const tail = this.compositionTail;
    if (
      !tail ||
      !['insertText', 'insertFromComposition', 'insertCompositionText'].includes(event.inputType) ||
      (event.data !== tail.text &&
        !(
          event.data === null &&
          (event.inputType !== 'insertText' || this.ime.value === tail.text)
        ))
    )
      return false;
    this.context(tail.scope);
    // A noncancelable beforeinput still has an original input phase to consume.
    if (event.type !== 'beforeinput' || event.cancelable) this.compositionTail = undefined;
    if (event.cancelable) event.preventDefault();
    this.ime.value = '';
    return true;
  }
  private editSteps(inputType: string, data: string | null): BrowserInputStep[] | undefined {
    if (inputType === 'insertText' || inputType === 'insertFromPaste') {
      if (data === null || data.length === 0) return undefined;
      return [BrowserInputStepSchema.parse({ kind: 'text', text: data })];
    }
    const key =
      inputType === 'deleteContentBackward'
        ? 'Backspace'
        : inputType === 'deleteContentForward'
          ? 'Delete'
          : inputType === 'insertLineBreak' || inputType === 'insertParagraph'
            ? 'Enter'
            : undefined;
    return key
      ? [
          { kind: 'keyDown', key },
          { kind: 'keyUp', key },
        ]
      : undefined;
  }
  beforeEdit(event: InputEvent): void {
    if (
      this.port.closed() ||
      event.target !== this.ime ||
      event.isComposing ||
      this.port.composing()
    )
      return;
    try {
      if (this.swallowCompositionTail(event)) return;
      const inputType = event.inputType,
        data = event.data;
      const scope = this.editable;
      if (!scope) throw this.port.stale();
      const context = this.context(scope);
      this.port.cancelGesture();
      // The receiver contains no canonical remote surrounding text. Replacement/autocorrection,
      // local selection edits and unknown input types cannot guess the remote range.
      if (this.ime.value !== '' || this.ime.selectionStart !== 0 || this.ime.selectionEnd !== 0) {
        if (event.cancelable) event.preventDefault();
        this.ime.value = '';
        this.edit = undefined;
        return;
      }
      if (
        ![
          'insertText',
          'insertFromPaste',
          'deleteContentBackward',
          'deleteContentForward',
          'insertLineBreak',
          'insertParagraph',
        ].includes(inputType)
      ) {
        if (event.cancelable) event.preventDefault();
        return;
      }
      const steps = this.editSteps(inputType, data);
      if (!event.cancelable || (!steps && data === null)) {
        this.context(scope);
        this.edit = { inputType, data, scope };
        return;
      }
      if (!steps) {
        event.preventDefault();
        return;
      }
      this.port.issue(context, steps, () => {
        event.preventDefault();
        this.edit = undefined;
        this.ime.value = '';
      });
    } catch {
      this.edit = undefined;
      this.ime.value = '';
    }
  }
  inputEvent(event: InputEvent): void {
    if (this.port.closed() || event.target !== this.ime) return;
    if (event.isComposing || this.port.composing()) {
      this.port.updateComposition();
      return;
    }
    try {
      if (this.swallowCompositionTail(event)) return;
      const edit = this.edit;
      this.edit = undefined;
      const context = this.context(edit?.scope);
      if (
        edit &&
        (edit.inputType !== event.inputType ||
          (edit.data !== null && event.data !== null && event.data !== edit.data) ||
          (edit.data !== null &&
            event.data === null &&
            ['insertText', 'insertFromPaste'].includes(edit.inputType) &&
            this.ime.value !== edit.data))
      ) {
        this.ime.value = '';
        return;
      }
      const data =
        event.data ??
        edit?.data ??
        (event.inputType === 'insertText' || event.inputType === 'insertFromPaste'
          ? this.ime.value
          : null);
      const steps = this.editSteps(event.inputType, data);
      if (!steps) {
        this.ime.value = '';
        return;
      }
      this.port.issue(context, steps, () => {
        this.ime.value = '';
      });
    } catch {
      this.edit = undefined;
      this.ime.value = '';
    }
  }
  paste(event: ClipboardEvent): void {
    if (this.port.closed() || this.port.composing() || event.target !== this.ime) return;
    try {
      const context = this.context();
      const clipboard = event.clipboardData;
      if (!clipboard || !event.cancelable) return;
      event.preventDefault(); // Consume the original gesture even if its text is malformed/oversized.
      // Read only the clipboard data attached to this actual paste gesture, never system clipboard APIs.
      const getData = clipboard.getData;
      const text = getData.call(clipboard, 'text/plain');
      const steps = this.editSteps('insertFromPaste', text);
      if (!steps) {
        this.ime.value = '';
        return;
      }
      this.port.issue(context, steps, () => {
        this.edit = undefined;
        this.ime.value = '';
      });
    } catch {
      this.edit = undefined;
      this.ime.value = '';
    }
  }
}
