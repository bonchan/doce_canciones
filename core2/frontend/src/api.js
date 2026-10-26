// Where the backend is. By default the same address this page came from: on the NUC the backend serves
// the built webapp itself on port 8000, and the dev server (pnpm dev) forwards /api and /ws to it (see
// vite.config.js) — so this works from any computer, by name, IPv4 or IPv6 address.
// Set VITE_API_BASE (e.g. http://nuc.local:8000) only to talk to a backend somewhere else directly.
export const API_BASE = (import.meta.env.VITE_API_BASE || window.location.origin).replace(/\/$/, '');
export const WS_BASE = API_BASE.replace(/^http/, 'ws');

/** JSON request; throws an Error with the backend's `detail` message when it answers with an error. */
export async function request(method, path, { apiKey, body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(apiKey ? { 'X-API-Key': apiKey } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `${res.status} ${res.statusText}`);
  return data;
}
