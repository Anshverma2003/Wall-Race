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
