/**
 * Keeps the job link box ready to type in: whenever someone comes to the app or moves between
 * pages, without ever taking the cursor from a field they are typing in or a dialog they have open.
 */

let input: HTMLInputElement | null = null;

export function registerAddBarInput(element: HTMLInputElement | null): void {
  input = element;
}

/** A text field, an open menu or dialog: somewhere the person is busy, which keeps the cursor. */
function busyElsewhere(): boolean {
  const active = document.activeElement as HTMLElement | null;
  if (active && active !== input && active !== document.body) {
    const tag = active.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active.isContentEditable) return true;
    if (active.getAttribute('role') === 'combobox' && active.getAttribute('aria-expanded') === 'true') return true;
  }
  return !!document.querySelector('[role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"]');
}

/** After the current click or keypress has finished, so that nothing moves the cursor away again. */
export function focusAddBar(options: { select?: boolean; force?: boolean } = {}): void {
  requestAnimationFrame(() => {
    if (!input || input.disabled) return;
    if (!options.force && busyElsewhere()) return;
    input.focus({ preventScroll: true });
    if (options.select) input.select();
  });
}
