export function now() {
  return new Date();
}

export function iso(ts = now()) {
  return ts.toISOString();
}

export function parseIso(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

export function secondsFromNow(sec) {
  return new Date(Date.now() + sec * 1000);
}
