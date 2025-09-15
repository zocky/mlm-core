/*  Zero-dependency micro test runner  (C) 2025 – public domain  */
const RESET = '\x1b[0m', RED = '\x1b[31m', GREEN = '\x1b[32m', YELLOW = '\x1b[33m', DIM = '\x1b[2m';

let depth = 0, total = 0, failed = 0, failures = [], onlyMode = false, onlys = [];

/* ---------- helpers ---------- */
const indent = () => '  '.repeat(depth);

const log = (...args) => console.log(indent(), ...args);

function print(msg, colour = '') { log(colour + msg + RESET); }

/* ---------- public API ---------- */
export function describe(title, fn) {
  print('▶ ' + title, YELLOW);
  depth++;
  fn();
  depth--;
}

export function it(title, fn) {
  if (onlyMode && !onlys.includes(fn)) return;
  total++;
  try {
    fn();
    print('✓ ' + title, GREEN);
  } catch (err) {
    failed++;
    print('✗ ' + title, RED);
    failures.push({ title, err });
  }
}
it.only = (title, fn) => { onlyMode = true; onlys.push(fn); it(title, fn); };

export function assert(cond, msg = 'Assertion failed') {
  if (!cond) throw new Error(msg);
}

export function assertThrows(fn, expectedMsg) {
  let threw = false, err;
  try { fn(); } catch (e) { threw = true; err = e; }
  if (!threw) throw new Error('Expected function to throw');
  if (expectedMsg && !err.message.includes(expectedMsg)) {
    throw new Error(`Expected error containing "${expectedMsg}", got "${err.message}"`);
  }
}

export function assertDoesNotThrow(fn) {
  try { fn(); } catch (e) { throw new Error(`Expected no error, got: ${e.message}`); }
}

export function report() {
  console.log('\n' + DIM + '--- Summary ---' + RESET);
  if (failed) {
    failures.forEach(({ title, err }) => {
      print(title, RED);
      console.log(DIM + err.stack.split('\n').map(l => '   ' + l).join('\n') + RESET);
    });
    console.log(`\n${RED}Failed: ${failed}/${total}${RESET}`);
    process.exit(1);
  } else {
    console.log(`${GREEN}All ${total} tests passed ✨${RESET}`);
    process.exit(0);
  }
}