// Tiny wrapper around the Umami client. The script is loaded async by
// index.html, so callers may run before `umami` is defined — the typeof
// guard makes early calls a silent no-op rather than a ReferenceError.
// eslint-disable-next-line import/prefer-default-export
export function track(event, data) {
  if (typeof umami !== 'undefined') umami.track(event, data);
}
