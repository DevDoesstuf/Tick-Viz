export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000';
export const WS_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:8000/ws/ticks';

export async function setServerTickRate(rate: number): Promise<void> {
  try {
    await fetch(`${API_BASE_URL}/control/rate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rate }),
    });
  } catch {
    // Best-effort: the rate slider still reflects local UI state even if
    // the control request fails (e.g. backend not running yet); the next
    // successful request will bring the server in sync.
  }
}

export async function fetchSymbols(): Promise<string[]> {
  try {
    const res = await fetch(`${API_BASE_URL}/symbols`);
    const data = (await res.json()) as { symbols: string[] };
    return data.symbols;
  } catch {
    return [];
  }
}
