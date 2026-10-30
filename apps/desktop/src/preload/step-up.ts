/**
 * The preload of the Mac app's "Confirm it's you" window (DOR-3234).
 *
 * The window's page runs no script; this fills it in and sends what is typed
 * straight to the shell, which talks to the server (`src/main/step-up/`).
 * Nothing is exposed to the page: there is no `contextBridge` here, so even a
 * page that somehow ran script would find no way to the shell.
 */
import { ipcRenderer } from 'electron';

import type {
  StepUpWindowAnswer,
  StepUpWindowSubmit,
  StepUpWindowView,
} from '../shared/step-up-page';

// Mirrors of the `STEP_UP_WINDOW_*_CHANNEL` constants in `shared/step-up-page.ts`.
// Duplicated, not imported, so this preload is one file with no shared chunk,
// which a sandboxed preload could not load (`src/main/step-up/__tests__/step-up-channels.test.ts`
// keeps them equal).
const STEP_UP_WINDOW_VIEW_CHANNEL = 'step-up-window:view';
const STEP_UP_WINDOW_SUBMIT_CHANNEL = 'step-up-window:submit';
const STEP_UP_WINDOW_CLOSE_CHANNEL = 'step-up-window:close';

const RESET_PASSWORD_COMMAND = 'dorkos auth reset-password';

function byId<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

function end(message: string): void {
  byId('form').hidden = true;
  byId('ended-message').textContent = message;
  byId('ended').hidden = false;
  byId<HTMLButtonElement>('close').focus();
}

function close(): void {
  void ipcRenderer.invoke(STEP_UP_WINDOW_CLOSE_CHANNEL);
}

/** Show the server's words; `textContent` only, so nothing in them is markup. */
function show(view: StepUpWindowView): void {
  byId('reason').textContent = view.reason;
  const notes = byId('notes');
  for (const note of view.notes) {
    const line = document.createElement('p');
    line.className = 'muted';
    line.textContent = note;
    notes.append(line);
  }
  if (view.unavailable === 'insecure-connection') {
    end('Confirm this on the computer running DorkOS.');
    return;
  }
  if (view.unavailable === 'no-password') {
    end(
      `This computer has no DorkOS password yet. Set one in a terminal: ${RESET_PASSWORD_COMMAND}`
    );
    return;
  }
  byId('form').hidden = false;
  byId<HTMLInputElement>('password').focus();
}

let changing = false;
let pending = false;

async function submit(): Promise<void> {
  if (pending) return;
  const status = byId('status');
  const password = byId<HTMLInputElement>('password').value;
  const body: StepUpWindowSubmit = changing
    ? {
        kind: 'change',
        currentPassword: password,
        newPassword: byId<HTMLInputElement>('new-password').value,
      }
    : { kind: 'password', password };
  pending = true;
  byId<HTMLButtonElement>('confirm').disabled = true;
  status.className = '';
  status.textContent = 'Checking…';
  const answer = (await ipcRenderer.invoke(
    STEP_UP_WINDOW_SUBMIT_CHANNEL,
    body
  )) as StepUpWindowAnswer;
  pending = false;
  byId<HTMLButtonElement>('confirm').disabled = false;
  if (answer.kind === 'confirmed') return; // The shell closes the window.
  if (answer.kind === 'ended') {
    end(answer.message);
    return;
  }
  if (answer.kind === 'too-short') {
    changing = true;
    const tooShort = byId('too-short');
    tooShort.textContent = `Your password is too short. Choose one of at least ${answer.minLength} characters.`;
    tooShort.hidden = false;
    byId('password-label').textContent = 'Current password';
    byId('new-password-row').hidden = false;
    const next = byId<HTMLInputElement>('new-password');
    next.required = true;
    next.minLength = answer.minLength;
    byId('confirm').textContent = 'Change and confirm';
    status.textContent = '';
    next.focus();
    return;
  }
  status.className = 'error';
  status.textContent = answer.message;
  byId<HTMLInputElement>('password').select();
}

window.addEventListener('DOMContentLoaded', () => {
  byId('form').addEventListener('submit', (event) => {
    event.preventDefault();
    void submit();
  });
  byId('cancel').addEventListener('click', close);
  byId('close').addEventListener('click', close);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close();
  });
  void ipcRenderer
    .invoke(STEP_UP_WINDOW_VIEW_CHANNEL)
    .then((view: StepUpWindowView | { ended: string }) => {
      if ('ended' in view) end(view.ended);
      else show(view);
    });
});
