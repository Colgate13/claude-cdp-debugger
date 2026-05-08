// Long-running target process used by integration tests.
// Calls `tick(input)` every 50ms; tests set a breakpoint inside `tick`
// and inspect runtime state.

let counter = 0;
let lastValue = 0;

function tick(input) {
  counter += 1;
  lastValue = input * 2;
  // Breakpoint normally set on the next line — by then `input` (parameter) is in
  // local scope and `counter`/`lastValue` are reachable from enclosing scope.
  return lastValue;
}

setInterval(() => tick(counter + 1), 50);
console.log('target ready');
