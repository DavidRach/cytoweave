// Whether the user is in the middle of a pointer interaction (dragging a gate, drawing one), so
// background work that would make it stutter (statistics filled in a channel at a time) can wait.

let pointers = 0;
let lastEnd = 0;
let lastStart = 0;

export function interactionStarted() {
  pointers += 1;
  lastStart = performance.now();
}

export function interactionEnded() {
  pointers = Math.max(0, pointers - 1);
  lastEnd = performance.now();
}

// True while a pointer is down on a plot, shortly after, or while input waits to be handled.
export function isInteracting() {
  // A pointer that never came up (a lost event) stops counting after a minute.
  if (pointers > 0 && performance.now() - lastStart > 60000) pointers = 0;
  return pointers > 0 || performance.now() - lastEnd < 150 || Boolean(globalThis.navigator?.scheduling?.isInputPending?.());
}
