// One place to build API URLs correctly in both dev & prod.
const RAW = (import.meta as any)?.env?.VITE_API_URL;
export const API_BASE = typeof RAW === "string" && RAW.trim() ? RAW.trim().replace(/\/+$/, "") : "/api";

// Joins path safely to API_BASE
export function apiUrl(path: string) {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${p}`;
}

export async function apiFetch(path: string, init?: RequestInit) {
  const res = await fetch(apiUrl(path), init);
  return res;
}