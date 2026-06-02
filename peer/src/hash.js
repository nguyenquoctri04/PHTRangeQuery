import crypto from 'crypto';

export const M = 8;
export const RING_SIZE = 2 ** M;

export function hashId(key) {
  return parseInt(crypto.createHash('sha1').update(String(key)).digest('hex').substring(0, 2), 16) % RING_SIZE;
}

export function normalizeId(id) {
  return ((Number(id) % RING_SIZE) + RING_SIZE) % RING_SIZE;
}

export function inOpenClosed(value, start, end) {
  value = normalizeId(value);
  start = normalizeId(start);
  end = normalizeId(end);
  if (start === end) return true;
  if (start < end) return value > start && value <= end;
  return value > start || value <= end;
}

export function inOpenOpen(value, start, end) {
  value = normalizeId(value);
  start = normalizeId(start);
  end = normalizeId(end);
  if (start === end) return value !== start;
  if (start < end) return value > start && value < end;
  return value > start || value < end;
}
