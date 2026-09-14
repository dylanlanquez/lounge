// Node 26 declares a global `localStorage` that is `undefined` unless the
// process was started with --localstorage-file, and vitest's jsdom
// environment deliberately does not copy any window key that already exists
// on the Node global. The result is a jsdom test where `localStorage` reads
// as unavailable while `sessionStorage` works, which makes anything
// storage-backed untestable rather than failing honestly.
//
// Point the global at the jsdom window's real Storage. `globalThis.jsdom` is
// set by vitest's jsdom environment and absent under the node environment,
// so node-environment tests are left alone.
const dom = (globalThis as { jsdom?: { window: Window } }).jsdom;

if (dom && typeof globalThis.localStorage === 'undefined') {
  Object.defineProperty(globalThis, 'localStorage', {
    value: dom.window.localStorage,
    configurable: true,
    writable: true,
  });
}
