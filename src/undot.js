// undot.js – recursively expand dotted keys, but only into plain objects
export function undot(obj) {
  const isPlain = o =>
    o != null && (Object.getPrototypeOf(o) === Object.prototype || Object.getPrototypeOf(o) === null);

  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    let target = out;
    const parts = k.split('.');
    const last = parts.pop();
    for (const p of parts) {
      if (!isPlain(target[p])) target[p] = {}; // overwrite non-plain
      target = target[p];
    }
    target[last] = v;
  }
  return out;
}