export const HUB_UNREACHABLE = 'Can’t reach Pi Hub on your machine. Check your internet connection and make sure the machine is awake, Pi Hub is running, and any VPN or tunnel is connected.';

export class ApiError extends Error {
  constructor(message: string, public status?: number) { super(message); }
}

// Bound both the request and response-body read: an offline tunnel can otherwise
// leave startup (or reconnection) waiting for the browser's much longer timeout.
export async function api(route: string, data?: unknown, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('/api/' + route, {
      method: data === undefined ? 'GET' : 'POST', cache: 'no-store', signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
    });
    // Reverse proxies often return HTML, not the Hub's JSON error envelope.
    let result;
    try { result = await res.json(); }
    catch {
      if (controller.signal.aborted) throw new ApiError(HUB_UNREACHABLE);
      if (res.ok) throw new ApiError('Pi Hub returned an unexpected response. Refresh to try again.', res.status);
    }
    if (!res.ok) throw new ApiError([502, 503, 504].includes(res.status) ? HUB_UNREACHABLE : result?.error || `Pi Hub request failed (HTTP ${res.status}).`, res.status);
    return result;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(HUB_UNREACHABLE);
  } finally { clearTimeout(timer); }
}

export async function workspaceStatus() {
  const [status, authenticated] = await Promise.all([
    api('auth/status'),
    api('me').then(() => true).catch(error => {
      if (error.status === 401) return false;
      throw error;
    }),
  ]);
  return { twoFactorEnabled: status.twoFactorEnabled, authenticated };
}
