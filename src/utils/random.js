import { ROOM } from '../config.js';

/** Cryptographically strong random integer in [0, max). */
export function randomInt(max) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % max;
}

/** A 6-digit numeric room code that never starts with 0 (easier to read aloud). */
export function generateRoomCode() {
  const min = 10 ** (ROOM.CODE_LENGTH - 1);
  return String(min + randomInt(9 * min));
}

export function isValidRoomCode(code) {
  return new RegExp(`^[0-9]{${ROOM.CODE_LENGTH}}$`).test(code);
}

export function generateId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** RFC 4122 v4 UUID (also works on plain-HTTP pages where crypto.randomUUID is missing). */
export function generateUuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Random unsigned 32-bit integer (AI game seed). */
export function randomUint32() {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}
