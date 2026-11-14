/** Runs before site scripts; the broker and Chromium's native popup blocker remain authoritative. */
export function installWindowPolicy({
  control,
  report,
}: {
  control: string;
  report: string;
}): void {
  const scope = window as unknown as Record<string, unknown>;
  if (scope[control]) return;
  let held = false;
  let personInput = false;
  const open = window.open.bind(window);
  const submit = HTMLFormElement.prototype.submit;
  const requestSubmit = HTMLFormElement.prototype.requestSubmit;
  // Object methods keep this function serializable even in the CLI's keepNames build.
  const rules = {
    allowed() {
      return held && personInput && navigator.userActivation?.isActive;
    },
    denied() {
      // A raw CDP binding is one-way: no Playwright evaluation delivers a reply.
      (scope[report] as ((payload: string) => void) | undefined)?.('');
    },
    retarget(element: Element, attribute: string, fallback?: Element) {
      const target =
        element.getAttribute(attribute) ??
        fallback?.getAttribute('target') ??
        document.querySelector('base[target]')?.getAttribute('target');
      if (!target || target.toLowerCase() === '_self' || this.allowed()) return;
      element.setAttribute(attribute, '_self');
      this.denied();
    },
    form(form: HTMLFormElement, submitter?: HTMLElement | null) {
      if (submitter?.hasAttribute('formtarget')) this.retarget(submitter, 'formtarget', form);
      else this.retarget(form, 'target');
    },
  };
  Object.defineProperty(scope, control, {
    value(value: boolean) {
      if (held !== value) personInput = false;
      held = value;
    },
  });
  // Metadata/agent evaluations can carry activation too. Only input received after takeover counts.
  for (const type of ['pointerup', 'keydown', 'click'])
    document.addEventListener(
      type,
      (event) => {
        if (held && event.isTrusted && navigator.userActivation?.isActive) personInput = true;
      },
      true
    );
  window.open = (...args) => {
    if (rules.allowed()) return open(...args);
    rules.denied();
    return null;
  };
  HTMLFormElement.prototype.submit = function () {
    rules.form(this);
    return Reflect.apply(submit, this, []);
  };
  HTMLFormElement.prototype.requestSubmit = function (submitter) {
    rules.form(this, submitter);
    return Reflect.apply(requestSubmit, this, submitter === undefined ? [] : [submitter]);
  };
  document.addEventListener(
    'submit',
    (event) => {
      if (event.target instanceof HTMLFormElement)
        rules.form(event.target, (event as SubmitEvent).submitter);
    },
    true
  );
  document.addEventListener(
    'click',
    (event) => {
      if (!(event.target instanceof Element)) return;
      const link = event.target.closest('a[href],area[href]');
      if (link) rules.retarget(link, 'target');
      const button = event.target.closest('button,input');
      if (
        ((button instanceof HTMLButtonElement && button.type === 'submit') ||
          (button instanceof HTMLInputElement &&
            (button.type === 'submit' || button.type === 'image'))) &&
        button.form
      )
        rules.form(button.form, button);
    },
    true
  );
}
