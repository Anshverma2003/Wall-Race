/**
 * Minimal Supabase REST client for the server, using the SECRET key.
 * Never import this from browser code.
 */
import { SUPABASE } from '../../src/config.js';

function credentials() {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key) throw Object.assign(new Error('SUPABASE_SECRET_KEY is not configured.'), { status: 500 });
  return { url: process.env.SUPABASE_URL || SUPABASE.URL, key };
}

async function request(path, { method = 'GET', body } = {}) {
  const { url, key } = credentials();
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: { apikey: key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw Object.assign(new Error(data?.message || `Supabase error ${res.status}`), { status: 502 });
  }
  return data;
}

/** @returns {Promise<string|null>} player id for a recovery-code hash */
export async function playerIdForSecretHash(hash) {
  const rows = await request(`players?secret_hash=eq.${hash}&select=id`);
  return rows?.[0]?.id ?? null;
}

export const rpc = (name, args) => request(`rpc/${name}`, { method: 'POST', body: args });
