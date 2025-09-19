import React, { useMemo, useRef, useState } from "react";
import Card from "../components/ui/Card";
import Input from "../components/ui/Input";
import Button from "../components/ui/Button";
import Timeline from "../components/ui/Timeline";

const API_BASE = (import.meta as any)?.env?.VITE_API_URL
  ? String((import.meta as any).env.VITE_API_URL).replace(/\/+$/, "")
  : "";

// --- Lightweight browser cache for statuses (UI speed only; DB remains source-of-truth)
const STATUS_CACHE_KEY = "sla_cache_status_by_app_v2";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

function _readMap(k: string) { try { return JSON.parse(localStorage.getItem(k) || "{}"); } catch { return {}; } }
function _writeMap(k: string, v: any) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { } }
function getCachedStatuses(_appIdRaw: string): StatusRow[] | null {
  // Browser cache disabled — DB is the cache of record
  return null;
}
function setCachedStatuses(_appIdRaw: string, _statuses: StatusRow[]) {
  // No-op
}


// ---- Tiny formatters & helpers ----
const fmtInt = (n: number | null | undefined) =>
  typeof n === "number" && Number.isFinite(n) ? n.toLocaleString() : "—";
const fmtArea = (n: number | null | undefined) =>
  typeof n === "number" && Number.isFinite(n) ? `${n.toLocaleString()} h` : "—";
const uniq = <T,>(arr: T[]) => Array.from(new Set(arr));

function canonId(s: string | null | undefined): string {
  return String(s ?? "").trim().toUpperCase();
}

/**
 * Format a Date as DD/MM/YYYY, or "—" for null/undefined.
 */
function fmtDate(d: Date | null): string {
  if (!d || !(d instanceof Date) || isNaN(d.getTime())) return "—";
  // Pad day and month to 2 digits
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

// ---- Robust date parsing and helpers ----
/**
 * Parse a date string in various loose formats (YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, "22-09-2023 12:04:17 PM", etc.)
 */
function parseDateLoose(s?: string | null): Date | null {
  if (!s || typeof s !== "string") return null;
  const t = s.trim();

  // ISO guard (only trust true ISO like 2024-09-23…)
  const iso = Date.parse(t);
  if (!Number.isNaN(iso) && /\d{4}-\d{2}-\d{2}/.test(t)) return new Date(iso);

  // DD-MM-YYYY with optional time + AM/PM
  let m = t.match(
    /^\s*(\d{1,2})-(\d{1,2})-(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?)?\s*$/
  );
  if (m) {
    let [, dStr, mStr, yStr, hhStr, mmStr, ssStr, apStr] = m;
    let day = Number(dStr);
    let mon = Number(mStr) - 1;
    let year = yStr.length === 2 ? Number("20" + yStr) : Number(yStr);
    let hh = Number(hhStr || "0");
    const mm = Number(mmStr || "0");
    const ss = Number(ssStr || "0");
    if (apStr) {
      const ap = apStr.toUpperCase();
      if (ap === "PM" && hh < 12) hh += 12;
      if (ap === "AM" && hh === 12) hh = 0;
    }
    const d = new Date(year, mon, day, hh, mm, ss);
    return isNaN(d.getTime()) ? null : d;
  }

  // DD/MM/YYYY with optional time + AM/PM (e.g. 7/9/23 15:27)
  m = t.match(
    /^\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?)?\s*$/
  );
  if (m) {
    let [, dStr, mStr, yStr, hhStr, mmStr, ssStr, apStr] = m;
    let day = Number(dStr);
    let mon = Number(mStr) - 1;
    let year = yStr.length === 2 ? Number("20" + yStr) : Number(yStr);
    let hh = Number(hhStr || "0");
    const mm = Number(mmStr || "0");
    const ss = Number(ssStr || "0");
    if (apStr) {
      const ap = apStr.toUpperCase();
      if (ap === "PM" && hh < 12) hh += 12;
      if (ap === "AM" && hh === 12) hh = 0;
    }
    const d = new Date(year, mon, day, hh, mm, ss);
    return isNaN(d.getTime()) ? null : d;
  }

  return null;
}
function addYears(date: Date, years: number): Date {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + years);
  return d;
}
function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}
function daysBetweenUTC(a: Date, b: Date): number {
  // Returns integer days between two dates in UTC
  const utc1 = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const utc2 = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((utc2 - utc1) / (1000 * 60 * 60 * 24));
}

function timeAgo(from: Date, to: Date = new Date()): string {
  const sec = Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1000));
  const m = Math.floor(sec / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  const mo = Math.floor(d / 30);
  const y = Math.floor(d / 365);
  if (sec < 60) return `${sec}s ago`;
  if (m < 60) return `${m}m ago`;
  if (h < 24) return `${h}h ago`;
  if (d < 30) return `${d}d ago`;
  if (mo < 12) return `${mo}mo ago`;
  return `${y}y ago`;
}

// ---- Normalizers for mixed data coming from DB/TN (NULL strings, odd dates, commas) ----
function cleanStr(s?: string | null): string | undefined {
  if (s == null) return undefined;
  const t = String(s).trim();
  if (!t || /^null$/i.test(t)) return undefined;
  return t;
}
function cleanNumber(v: any): number | null {
  if (v == null) return null;
  const t = String(v).trim();
  if (!t || /^null$/i.test(t)) return null;
  // remove thousand separators/spaces
  const n = Number(t.replace(/[, ]+/g, ""));
  return Number.isFinite(n) ? n : null;
}
function normalizeSurvey(s?: string | null): string | undefined {
  const t = cleanStr(s);
  if (!t) return undefined;
  // collapse spaces and normalize commas like "362/3 , 363/3" -> "362/3, 363/3"
  return t.replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ");
}

// Split a survey number string into unique, trimmed survey numbers
function splitSurveys(input?: string): string[] {
  const s = (input || "").trim();
  if (!s) return [];
  return Array.from(
    new Set(
      s
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean)
    )
  );
}

// --- Company name canonicalization (to eliminate duplicates like case/spacing variants) ---
function canonCompanyKey(name?: string | null): string | null {
  if (!name) return null;
  let t = String(name).trim().toLowerCase();

  // Normalize whitespace and common punctuation
  t = t.replace(/[\s\.\-_,/()&]+/g, " ");

  // Remove common legal suffixes (keep core identity)
  t = t.replace(/\b(private|pvt|pvtltd|pvt ltd|privatelimited|limited|ltd|co|company|enterprises|enterprise)\b/g, "");

  // Collapse multiple spaces
  t = t.replace(/\s+/g, " ").trim();

  // Remove stray quotes
  t = t.replace(/["'`]+/g, "");

  return t || null;
}

function prettifyCompanyName(name: string): string {
  if (!name) return "";
  // Collapse whitespace first
  const t = name.replace(/\s+/g, " ").trim();
  // Simple Title Case without touching existing acronyms fully in caps
  return t
    .split(" ")
    .map(word => {
      if (word.length <= 2) return word.toUpperCase();
      if (/^[A-Z0-9]+$/.test(word)) return word; // keep acronyms
      const lower = word.toLowerCase();
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

// --- Detect & normalize Application ID (alphanumeric with dashes like NKL-npt-00071412-2017-18) ---
function isAppIdLike(s: string): boolean {
  const t = (s || "").trim();
  // Heuristic: must contain at least one letter and one dash (so we don't mistake 10/12-digit numbers)
  return /[A-Za-z]/.test(t) && /-/.test(t);
}
function cleanAppId(s: string): string {
  let t = (s || "").trim();

  // Strip wrapping quotes/backticks if present
  t = t.replace(/^["'`]+|["'`]+$/g, "");

  // Normalize whitespace (incl. non-breaking spaces)
  t = t.replace(/\u00A0/g, " ").replace(/\s+/g, " ");

  // Drop any trailing non word/dash chars
  t = t.replace(/[^\w-]+$/g, "");

  // If an alpha tail like “…-2017-18w” exists, drop the tail (keep up to the year segment)
  t = t.replace(/(^.*?\b\d{4}-\d{2})(?:[A-Za-z]+)$/i, "$1");

  return t;
}

// ---- Robust fetch helpers (timeout + safe JSON parsing) ----
async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, ms = 30000): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (e) {
    // Normalize abort/timeouts so callers can handle them uniformly.
    const msg = String(e?.message || "");
    if (e?.name === "AbortError" || /aborted|abort/i.test(msg)) {
      const err: any = new Error("Request timed out");
      err.code = "ETIMEDOUT";
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(id);
  }
}

/**
 * Read a response body safely as JSON.
 * - Returns `null` for 204/empty body.
 * - Throws a helpful Error if the body isn't JSON or JSON.parse fails (includes status and a snippet).
 */
async function readJsonSafe(r: Response): Promise<any> {
  const ct = r.headers.get("content-type") || "";
  if (r.status === 204) return null;
  const text = await r.text(); // read once
  if (!text) return null;
  const looksJson = /\bapplication\/json\b/i.test(ct) || /^[\s]*[{\[]/.test(text);
  if (!looksJson) {
    const snippet = text.slice(0, 180).replace(/\s+/g, " ");
    throw new Error(`Unexpected non-JSON response (${r.status} ${r.statusText}; ${ct || "no content-type"}). Body: ${snippet}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    const snippet = text.slice(0, 180).replace(/\s+/g, " ");
    throw new Error(`Invalid JSON from server (${r.status}). Body starts: ${snippet}`);
  }
}

/**
 * Try to fetch timeline rows directly from our DB statuses table for this application_id.
 * Tries a few common endpoints (POST/GET) and normalizes common shapes:
 * - [ ... ]
 * - { statuses: [...] }
 * - { data: [...] }
 * Returns `null` only if the DB endpoint isn't reachable/doesn't exist.
 * Returns [] when reachable but no rows found.
 */
async function fetchStatusesFromDB(appId: string): Promise<StatusRow[] | null> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = localStorage.getItem("sla_token");
  if (token) headers["Authorization"] = `Bearer ${token}`;

  type Candidate = { url: string; method: "GET" | "POST"; body?: any };

  const candidates: Candidate[] = [
    // Try query param first (some backends only expose this)
    { url: `${API_BASE}/api/statuses?appId=${encodeURIComponent(appId)}`, method: "GET" },
    // Preferred new-style endpoint (may not be deployed everywhere)
    { url: `${API_BASE}/api/statuses/by-appid`, method: "POST", body: { appId } },
    // Common REST variants
    { url: `${API_BASE}/api/statuses/${encodeURIComponent(appId)}`, method: "GET" },
    { url: `${API_BASE}/api/statuses/by-application-id/${encodeURIComponent(appId)}`, method: "GET" },
    // Search-style endpoint used in some builds
    { url: `${API_BASE}/api/search/statuses`, method: "POST", body: { appId } },
  ];

  for (const c of candidates) {
    try {
      const r = await fetchWithTimeout(
        c.url,
        {
          method: c.method,
          headers,
          ...(c.method === "POST" ? { body: JSON.stringify(c.body || {}) } : {}),
        },
        30000
      );
      if (!r.ok) {
        // 404 means endpoint exists but no data for this appId — treat as empty result.
        if (r.status === 404) return [];
        // Otherwise try next candidate (silent fallback)
        continue;
      }
      const json = await readJsonSafe(r);
      if (Array.isArray(json)) return json as StatusRow[];
      if (json && Array.isArray((json as any).statuses)) return (json as any).statuses as StatusRow[];
      if (json && Array.isArray((json as any).data)) return (json as any).data as StatusRow[];
      // Unknown shape — consider this candidate unsupported, try next.
    } catch {
      // ignore and try next candidate
    }
  }
  // No candidate worked; DB endpoint not available in this environment.
  return null;
}

function stripHtmlToText(html: string): string {
  try {
    return html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } catch {
    return html;
  }
}

function parsePrintTextForMeta(text: string): { mobile?: string; district?: string; block?: string; village?: string } {
  const out: { mobile?: string; district?: string; block?: string; village?: string } = {};
  const t = ` ${text} `;
  const m = t.match(/Mobile\s*(?:No\.?|Number)?\s*[:\-]\s*([0-9]{10,12})/i);
  if (m) out.mobile = m[1];
  const d = t.match(/District(?:\s*Name)?\s*[:\-]\s*([A-Za-z .]+)/i);
  if (d) out.district = d[1].trim();
  const b = t.match(/Block(?:\s*Name)?\s*[:\-]\s*([A-Za-z .]+)/i);
  if (b) out.block = b[1].trim();
  const v = t.match(/Village(?:\s*Name)?\s*[:\-]\s*([A-Za-z0-9 .\/\-]+)/i);
  if (v) out.village = v[1].trim();
  return out;
}

async function fetchPrintMeta(appId: string): Promise<{ mobile?: string; district?: string; block?: string; village?: string } | null> {
  try {
    const r = await fetchWithTimeout(`${API_BASE}/api/tn-print/${encodeURIComponent(String(appId))}`, { method: "GET" }, 60000);
    const ct = r.headers.get("content-type") || "";
    const raw = await r.text();
    if (!raw) return null;
    const text = /html|text\//i.test(ct) ? stripHtmlToText(raw) : stripHtmlToText(String(raw));
    const meta = parsePrintTextForMeta(text);
    if (!meta.mobile && !meta.district && !meta.block && !meta.village) return null;
    return meta;
  } catch {
    return null;
  }
}

/** Normalize a single application row to be UI-friendly */
function normalizeApp(a: AppRow): AppRow {
  // keep original applied_date text for display if parsing fails; otherwise ISO yyyy-mm-dd for consistency
  const parsed = parseDateLoose(cleanStr(a.applied_date) || "");
  const niceDate = parsed ? parsed.toISOString().slice(0, 10) : cleanStr(a.applied_date);

  return {
    ...a,
    application_id: cleanAppId(String(a.application_id)),
    // Accept legacy backend fields too (crop_name → crop_type)
    crop_type: cleanStr(a.crop_type ?? (a as any).crop_name),
    mi_name: cleanStr(a.mi_name),
    applied_date: niceDate,
    // Some payloads use farmer / applicant_name
    farmer_name: cleanStr(
      a.farmer_name ?? (a as any).farmer ?? (a as any).applicant_name
    ),
    mi_area: cleanNumber(
      a.mi_area ?? (a as any).mi_hectare ?? (a as any).miarea ?? (a as any).mi
    ),
    total_area: cleanNumber(
      a.total_area ?? (a as any).total_hectare ?? (a as any).hectare ?? (a as any).area
    ),
    survey_no: normalizeSurvey(
      a.survey_no ?? (a as any).survey ?? (a as any).survey_number
    ),
    subdivision_no: cleanStr(
      a.subdivision_no ?? (a as any).sub_division_no ?? (a as any).subdivision
    ),
    farmer_type: cleanStr(a.farmer_type),
    ss: cleanStr(a.ss),
    source: cleanStr(a.source),
    mobile: cleanStr(a.mobile),
    aadhaar: cleanStr(a.aadhaar),
    district: cleanStr((a as any).district),
    block: cleanStr((a as any).block),
    village: cleanStr((a as any).village)
  };
}

function mergeApps(oldList: AppRow[], newList: AppRow[]): AppRow[] {
  const map = new Map<string, AppRow>();
  for (const a of oldList) map.set(String(a.application_id), a);
  for (const b of newList) {
    const id = String(b.application_id);
    if (!map.has(id)) map.set(id, b);
  }
  return Array.from(map.values());
}

// ---- Inline icons (no deps) ----
const IconBase = (p: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} {...p} />
);
const IdIcon = (p: any) => (
  <IconBase {...p}><rect x="4" y="4" width="16" height="12" rx="2" /><path d="M7 8h6M7 12h10" /></IconBase>
);
const FarmerIcon = (p: any) => (
  <IconBase {...p} strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="9" r="3" />
    <path d="M4 20c3-4 13-4 16 0" />
  </IconBase>
);
const LeafIcon = (p: any) => (
  <IconBase {...p} strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 14c7 2 12-3 16-10 0 8-4 16-12 16-2 0-3-1-4-2" />
  </IconBase>
);
const AreaIcon = (p: any) => (
  <IconBase {...p}><rect x="3" y="7" width="18" height="10" rx="2" /><path d="M3 11h18" /></IconBase>
);
const DateIcon = (p: any) => (
  <IconBase {...p}><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 11h18" /></IconBase>
);
const PinIcon = (p: any) => (
  <IconBase {...p}><path d="M12 22s7-4 7-10a7 7 0 10-14 0c0 6 7 10 7 10z" /><circle cx="12" cy="12" r="2.5" /></IconBase>
);
const StatusDot = ({ color = "bg-emerald-500" }: { color?: string }) => (
  <span className={`inline-block h-2.5 w-2.5 rounded-full ${color}`} />
);
// ---- New icons ----
const FactoryIcon = (p: any) => (
  <IconBase {...p}><rect x="3" y="12" width="18" height="7" rx="2" /><path d="M7 12V7.5a1.5 1.5 0 013 0V12M14 12V9a1 1 0 012 0v3" /><path d="M9 17h1M14 17h1" /></IconBase>
);
const TypeIcon = (p: any) => (
  <IconBase {...p}><circle cx="12" cy="12" r="6" /><path d="M8 12h8M12 8v8" /></IconBase>
);
const CopyIcon = (p: any) => (
  <IconBase {...p}><path d="M9 9h9a2 2 0 0 1 2 2v9H11a2 2 0 0 1-2-2V9z" /><path d="M7 15H6a2 2 0 0 1-2-2V4h9a2 2 0 0 1 2 2v1" /></IconBase>
);
const CheckIcon = (p: any) => (
  <IconBase {...p} strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></IconBase>
);

// ---- Types ----
type AppRow = {
  application_id: string;
  crop_type?: string;
  mi_name?: string;
  applied_date?: string;
  farmer_name?: string;
  mi_area?: number | null;
  total_area?: number | null;
  survey_no?: string;
  subdivision_no?: string;
  farmer_type?: string;
  ss?: string;

  // NEW (backend now uses these instead of key_value)
  source?: string;
  mobile?: string;   // 10-digit mobile if searched via phone
  aadhaar?: string;  // 12-digit aadhaar if searched via aadhaar
  district?: string;
  block?: string;
  village?: string;
};


type StatusRow = {
  status_date?: string;
  status?: string;
  remarks?: string;
  components?: string;
  name?: string;
};

// Per-survey eligibility info
type SurveyElig = {
  survey: string;
  completedAt: Date | null;
  daysLeft: number;
  eligibleNow: boolean;
  counterTone: "red" | "amber" | "green";
};

// --- Helpers to pick the latest status by actual date (not array order) ---
function latestStatusByDate(arr?: StatusRow[] | null): { item?: StatusRow; date: Date | null } {
  if (!arr || !arr.length) return { item: undefined, date: null };
  let bestItem: StatusRow | undefined = undefined;
  let bestDate: Date | null = null;
  for (const s of arr) {
    const d = s?.status_date ? parseDateLoose(s.status_date) : null;
    if (d && (!bestDate || d > bestDate)) {
      bestDate = d;
      bestItem = s;
    }
  }
  return { item: bestItem, date: bestDate };
}
function latestStatusByDateWhere(arr: StatusRow[] | undefined, pred: (s: StatusRow) => boolean): { item?: StatusRow; date: Date | null } {
  if (!arr || !arr.length) return { item: undefined, date: null };
  const filtered = arr.filter(pred);
  return latestStatusByDate(filtered);
}

const ShimmerStyles = () => (
  <style>{`
    @keyframes shimmer { 0%{transform:translateX(-100%)} 100%{transform:translateX(100%)} }
  `}</style>
);

export default function FetchInfo() {
  const [number, setNumber] = useState("");
  const [apps, setApps] = useState<AppRow[]>([]);
  // keep a live ref of apps for helpers that run async
  const appsRef = useRef<AppRow[]>([]);
  React.useEffect(() => { appsRef.current = apps; }, [apps]);
  const [statusesByApp, setStatusesByApp] = useState<Record<string, StatusRow[]>>({});
  // Track whether each application's timeline request has completed (success or error)
  const [timelineLoaded, setTimelineLoaded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [serverEmpty, setServerEmpty] = useState(false);
  const [copiedAppId, setCopiedAppId] = useState<string | null>(null);
  const [viewAppId, setViewAppId] = useState<string | null>(null);
  // --- Progressive loading phases for slow government sources ---
  type Phase = "idle" | "searching" | "cache-miss" | "fetching-status" | "done";
  const [phase, setPhase] = useState<Phase>("idle");
  const [statusTotal, setStatusTotal] = useState(0);
  const [statusDone, setStatusDone] = useState(0);
  const [showBanner, setShowBanner] = useState(false);
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Timer to show banner if local probe is slow
  const localProbeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);
  const [iframeErr, setIframeErr] = useState<string | null>(null);
  // Force unmount/mount of result sections on each new search so old DOM is cleared instantly
  const [searchKey, setSearchKey] = useState(0);
  // Track if this search already rendered local cached results
  const hadLocalPrefillRef = useRef(false);
  // Tracks if the current search got a server-side DB cache hit
  const cachedHitRef = useRef(false);
  // Keep the last search endpoint/body so we can poll for newly discovered apps
  const lastQueryRef = useRef<{ url: string; body: any; appIdMode: boolean } | null>(null);
  // Marks that the first HTTP response for this search has arrived
  const firstResponseRef = useRef(false);
  // Rotating loading messages while government sources are slow
  const rotatingPhrases = React.useMemo(() => [
    "Searching…",
    "Fetching data from government sources…",
    "Kindly wait…",
  ], []);
  const [rotIdx, setRotIdx] = useState(0);

  // Cycle the message while we're not done, but delay showing rotating phrases by 1 second
  React.useEffect(() => {
    if (phase === "idle" || phase === "done") return;
    setRotIdx(0);
    let intervalId: NodeJS.Timeout | undefined;
    const timeoutId = setTimeout(() => {
      intervalId = setInterval(() => setRotIdx((i) => (i + 1) % rotatingPhrases.length), 1400);
    }, 1000);
    return () => {
      clearTimeout(timeoutId);
      if (intervalId) clearInterval(intervalId);
    };
  }, [phase, rotatingPhrases]);
  // Auto-complete phase when timelines finish loading
  React.useEffect(() => {
    if (phase === "fetching-status" && statusTotal > 0 && statusDone >= statusTotal) {
      setPhase("done");
    }
  }, [phase, statusDone, statusTotal]);
  // Cleanup banner timer on unmount (top-level to preserve hook order)
  React.useEffect(() => {
    return () => {
      if (bannerTimerRef.current) {
        clearTimeout(bannerTimerRef.current);
        bannerTimerRef.current = null;
      }
      if (localProbeTimerRef.current) {
        clearTimeout(localProbeTimerRef.current);
        localProbeTimerRef.current = null;
      }
    };
  }, []);

  // Safely set iframe src via attribute (avoid DOM setter quirks)
  React.useEffect(() => {
    setIframeErr(null);
    const f = iframeRef.current;
    if (!f) return;
    if (!viewAppId) {
      try { f.removeAttribute('src'); } catch { }
      return;
    }
    try {
      const url = `${API_BASE}/api/tn-print/${encodeURIComponent(String(viewAppId))}`;
      // Use setAttribute to bypass any property-level validation bugs
      f.setAttribute('src', url);
    } catch (e: any) {
      console.error('iframe src set error:', e?.message || e);
      setIframeErr(e?.message || 'Unable to display preview');
      try { f.removeAttribute('src'); } catch { }
    }
  }, [viewAppId]);


  async function copyAppId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedAppId(id);
      setTimeout(() => setCopiedAppId(null), 1200);
    } catch { }
  }

  const activeReq = useRef(0);

  const token = useMemo(() => localStorage.getItem("sla_token"), []);

  // --- Helper: Should we enrich meta for a given app? ---
  function needsMeta(a: AppRow | undefined | null): boolean {
    if (!a) return true;
    const missDistrict = !a.district || !String(a.district).trim();
    const missBlock    = !a.block || !String(a.block).trim();
    const missVillage  = !a.village || !String(a.village).trim();
    const missMobile   = !a.mobile || !String(a.mobile).trim();
    return missDistrict || missBlock || missVillage || missMobile;
  }
  function anyNeedsMeta(list: AppRow[] | undefined | null): boolean {
    if (!Array.isArray(list) || list.length === 0) return true;
    // Enrich if ANY app is missing district/block/village/mobile
    return list.some(needsMeta);
  }
  // Pull all applications for a given mobile strictly from our local DB cache (no government calls)
  async function fetchAppsForMobileLocalOnly(mobile: string): Promise<AppRow[]> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = localStorage.getItem("sla_token");
    if (token) headers["Authorization"] = `Bearer ${token}`;

    const number = (mobile || "").replace(/\D/g, "");
    if (!number || number.length < 10) return [];

    try {
      const rLocal = await fetchWithTimeout(
        `${API_BASE}/api/search/number`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ number, strategy: "local-only" }),
        },
        60000
      );
      const jLocal = await readJsonSafe(rLocal);
      const list: AppRow[] = Array.isArray(jLocal?.applications) ? (jLocal.applications as AppRow[]) : [];
      return list.map(normalizeApp);
    } catch {
      return [];
    }
  }


  /**
   * Enrich District / Block / Village / (and missing mobile) for a set of application IDs
   * by scraping the TN print page. Runs sequentially to avoid hammering the source.
   * Returns how many apps were enriched and the discovered mobile (if any).
   */
  async function enrichMetaForApps(appIds: string[], knownMobile?: string): Promise<{ enriched: number; mobile?: string }> {
    let enriched = 0;
    let discoveredMobile: string | undefined = knownMobile;

    for (const id of appIds) {
      // Skip if we already have full meta in state for this app
      const key = canonId(id);
      let needsMeta = true;
      try {
        const current = (appsRef.current || []).find(a => canonId(a.application_id) === key);
        if (current && (current.district || current.block || current.village) && current.mobile) {
          needsMeta = false;
        }
      } catch { /* noop */ }
      if (!needsMeta) continue;

      const meta = await fetchPrintMeta(id);
      if (!meta) continue;

      // Set/keep discovered mobile
      if (!discoveredMobile && meta.mobile) {
        const m = String(meta.mobile).replace(/\D/g, "");
        if (m.length >= 10) discoveredMobile = m;
      }

      // Patch current rows with district/block/village/mobile if missing
      setApps(prev => {
        if (!prev || !prev.length) return prev;
        let changed = false;
        const next = prev.map(a => {
          if (canonId(a.application_id) !== key) return a;
          const p: AppRow = { ...a };
          if (!p.district && meta.district) { p.district = meta.district; changed = true; }
          if (!p.block && meta.block) { p.block = meta.block; changed = true; }
          if (!p.village && meta.village) { p.village = meta.village; changed = true; }
          if (!p.mobile && meta.mobile)  { p.mobile  = meta.mobile;  changed = true; }
          return p;
        });
        if (changed) enriched += 1;
        return next;
      });
    }

    return { enriched, mobile: discoveredMobile };
  }

  async function enrichFromPrintAndMaybeLoadMobileApps(appId: string): Promise<number> {
    // First, enrich this application's own meta (district/block/village/mobile)
    const first = await enrichMetaForApps([appId]);
    const metaMobile = first.mobile;

    // If mobile discovered, pull all apps for that mobile (local-first, silent)
    const mobile = (metaMobile || "").replace(/\D/g, "");
    if (mobile && mobile.length >= 10) {
      try {
        // Try local-only first
        const rLocal = await fetchWithTimeout(
          `${API_BASE}/api/search/number`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify({ number: mobile, strategy: "local-only" }),
          },
          60000
        );
        const jLocal = await readJsonSafe(rLocal);
        let list: AppRow[] = Array.isArray(jLocal?.applications) ? (jLocal.applications as AppRow[]) : [];

        // If empty, go local-first (may hit remote)
        if (!list || list.length === 0) {
          const r = await fetchWithTimeout(
            `${API_BASE}/api/search/number`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
              body: JSON.stringify({ number: mobile, strategy: "local-first" }),
            },
            120000
          );
          const j = await readJsonSafe(r);
          if (Array.isArray(j?.applications)) list = j.applications as AppRow[];
        }

        if (list && list.length) {
          const normalized = list.map(normalizeApp);
          let added = 0;
          setApps(prev => {
            const before = prev;
            const beforeIds = new Set(before.map(a => String(a.application_id)));
            const merged = mergeApps(before, normalized);
            const afterIds = new Set(merged.map(a => String(a.application_id)));
            // Count IDs that appear in after but not in before
            added = Array.from(afterIds).filter(id => !beforeIds.has(id)).length;
            return merged;
          });
          const newIds = normalized.map(a => a.application_id);
          setStatusTotal(t => Math.max(t, newIds.length));
          await Promise.all(newIds.map(id => fetchStatusesFor(id, "local-first")));
          return added;
        } else {
          return 0;
        }
      } catch {
        // swallow enrichment errors
        return 0;
      }
    }
    // No valid mobile discovered
    return 0;
  }


  React.useEffect(() => {
    // Only poll while search is still enriching
    if (phase !== "cache-miss" && phase !== "fetching-status") return;
    if (!lastQueryRef.current) return;

    let stopped = false;
    let unchangedRounds = 0;
    const maxRounds = 20; // ~60s total (20 * 3s)
    let rounds = 0;

    const tick = async () => {
      if (stopped || phase === "done") return;
      rounds += 1;
      try {
        const { url, body } = lastQueryRef.current!;
        const pollBody = { ...body, strategy: "local-first" };
        const r = await fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: JSON.stringify(pollBody),
          },
          30000
        );
        const json = await readJsonSafe(r);
        if (r.ok && json && Array.isArray(json.applications)) {
          const fresh = (json.applications as AppRow[]).map(normalizeApp);
          const before = apps;
          const merged = mergeApps(before, fresh);

          if (merged.length !== before.length) {
            setApps(merged);
            // fetch timelines for any *new* apps
            const oldIds = new Set(before.map(a => a.application_id));
            const newIds = merged.map(a => a.application_id).filter(id => !oldIds.has(id));
            if (newIds.length) {
              setStatusTotal((t) => Math.max(t, merged.length));
              (async () => {
                await Promise.all(newIds.map(id => fetchStatusesFor(id, "local-first")));
              })();
            }
            unchangedRounds = 0;
          } else {
            unchangedRounds += 1;
          }
        } else {
          unchangedRounds += 1;
        }
      } catch {
        unchangedRounds += 1;
      }
      if (rounds >= maxRounds || unchangedRounds >= 5 || stopped || phase === "done") return;
      setTimeout(tick, 3000);
    };

    const id = setTimeout(tick, 3000);
    return () => { stopped = true; clearTimeout(id); };
  }, [phase, apps, token]);
  const digitsOnly = (v: string) => (v || "").replace(/\D/g, "");

  // --- Aggregates & viz data ---
  const aggregates = useMemo(() => {
    if (!apps.length) return null;
    const crops = uniq(apps.map(a => (a.crop_type || "—").trim()).filter(Boolean));
    const byCrop = new Map<string, number>();
    apps.forEach(a => {
      const k = (a.crop_type || "Other").trim();
      byCrop.set(k, (byCrop.get(k) || 0) + 1);
    });
    const totalMI = apps.reduce((s, a) => s + (a.mi_area || 0), 0);
    const totalArea = apps.reduce((s, a) => s + (a.total_area || 0), 0);
    const latestApplied = apps
      .map(a => {
        const d = parseDateLoose(a.applied_date);
        return d ? d.getTime() : 0;
      })
      .reduce((m, t) => Math.max(m, t), 0);
    return { crops, byCrop, totalMI, totalArea, latestApplied };
  }, [apps]);

  // --- Pie for Global MI Area vs Total Area ---
  const globalAreaStyle = useMemo(() => {
    if (!aggregates) return undefined as React.CSSProperties | undefined;
    const totalMI = aggregates.totalMI || 0;
    const totalArea = aggregates.totalArea || 0;
    const rest = Math.max(0, totalArea - totalMI);
    const sum = totalMI + rest || 1;
    const miDeg = (totalMI / sum) * 360;
    const restDeg = 360 - miDeg;
    return {
      background: `conic-gradient(#10b981 0deg ${miDeg}deg, #e5e7eb ${miDeg}deg 360deg)`,
    } as React.CSSProperties;
  }, [aggregates]);

  // --- Location summary for District / Block / Village ---
  const locationSummary = useMemo(() => {
    const districts = uniq(apps.map(a => (a.district || "").trim()).filter(Boolean));
    const blocks = uniq(apps.map(a => (a.block || "").trim()).filter(Boolean));
    const villages = uniq(apps.map(a => (a.village || "").trim()).filter(Boolean));
    return { districts, blocks, villages };
  }, [apps]);

  // --- Per-survey eligibility ---
  const perSurveyEligibility = useMemo(() => {
    if (!apps.length) return [] as SurveyElig[];

    const latestBySurvey = new Map<string, Date>();

    for (const app of apps) {
      const surveys = splitSurveys(app.survey_no);
      if (!surveys.length) continue;

      const st = statusesByApp[canonId(app.application_id)] || [];
      const { item, date } = latestStatusByDateWhere(
        st,
        (r) => typeof r.status === "string" && /work\s*completed/i.test(String(r.status))
      );
      if (!date) continue;

      for (const sv of surveys) {
        const prev = latestBySurvey.get(sv);
        if (!prev || date > prev) latestBySurvey.set(sv, date);
      }
    }

    const today = new Date();
    const rows: SurveyElig[] = [];

    for (const [survey, completedAt] of latestBySurvey.entries()) {
      const dueAt = completedAt ? addYears(completedAt, 7) : null;
      const daysLeft = completedAt && dueAt ? daysBetweenUTC(today, dueAt) : 0;
      const eligibleNow = !!(dueAt && today >= dueAt);

      let counterTone: "red" | "amber" | "green" = "amber";
      if (!eligibleNow) {
        if (daysLeft > 365) counterTone = "red";
        else if (daysLeft < 45) counterTone = "green";
        else if (daysLeft > 90) counterTone = "amber";
      } else {
        counterTone = "green";
      }

      rows.push({
        survey,
        completedAt: completedAt || null,
        daysLeft: Math.max(0, daysLeft),
        eligibleNow,
        counterTone,
      });
    }

    rows.sort((a, b) => {
      const ta = a.completedAt ? a.completedAt.getTime() : -Infinity;
      const tb = b.completedAt ? b.completedAt.getTime() : -Infinity;
      return tb - ta;
    });

    return rows;
  }, [apps, statusesByApp]);

  // --- Completion & eligibility summary (across all apps)
  // We pick the LATEST status whose status text contains "Work Completed" across all application timelines.
  const completionSummary = useMemo(() => {
    if (!apps.length) return null;

    // Scan all timelines for the most recent "Work Completed" entry.
    let mostRecentWorkCompleted: Date | null = null;

    for (const a of apps) {
      const statuses = statusesByApp[canonId(a.application_id)];
      if (!Array.isArray(statuses) || statuses.length === 0) continue;
      for (const row of statuses) {
        const st = (row.status || "").toString();
        if (/work\s*completed/i.test(st)) {
          const d = parseDateLoose(row.status_date);
          if (d && (!mostRecentWorkCompleted || d > mostRecentWorkCompleted)) {
            mostRecentWorkCompleted = d;
          }
        }
      }
    }

    if (!mostRecentWorkCompleted) return null;

    const now = new Date();
    const dueAt = addYears(mostRecentWorkCompleted, 7);
    const daysLeft = daysBetweenUTC(now, dueAt);
    const eligibleNow = now >= dueAt;

    // Color for the day counter when NOT eligible yet
    // Red if > 365, Amber if > 90, Green if < 45 (45–90 => Amber as well)
    let counterTone: "red" | "amber" | "green" = "amber";
    if (daysLeft > 365) counterTone = "red";
    else if (daysLeft < 45) counterTone = "green";
    else if (daysLeft > 90) counterTone = "amber"; // explicit per requirement

    // Override rule: if ANY survey is eligible, show Eligible now.
    let overallEligible = eligibleNow;
    let displayDaysLeft = daysLeft;
    let tone: "red" | "amber" | "green" = counterTone;

    if (perSurveyEligibility.length > 0) {
      const anyEligible = perSurveyEligibility.some((sv) => sv.eligibleNow);
      if (anyEligible) {
        overallEligible = true;
        displayDaysLeft = 0;
        tone = "green";
      } else {
        const minDays = Math.min(...perSurveyEligibility.map((sv) => Math.max(0, sv.daysLeft)));
        if (Number.isFinite(minDays)) {
          displayDaysLeft = minDays;
          // recompute tone thresholds from minDays
          if (minDays > 365) tone = "red";
          else if (minDays < 45) tone = "green";
          else if (minDays > 90) tone = "amber";
          else tone = "amber";
        }
      }
    }

    return { completedAt: mostRecentWorkCompleted, daysLeft: displayDaysLeft, eligibleNow: overallEligible, counterTone: tone };
  }, [apps, statusesByApp, perSurveyEligibility]);

  // --- Companies preferred by Farmer (latest first) ---
  // --- Companies preferred by Farmer (latest first, de-duplicated by canonical key) ---
  const companiesPreferred = useMemo(() => {
    if (!apps.length) return [] as { display: string; latestAt: Date | null }[];

    // helper: decide the latest meaningful date for an application
    function latestDateForApp(a: AppRow): Date | null {
      const applied = parseDateLoose(a.applied_date);
      const statuses = statusesByApp[canonId(a.application_id)];
      const fromStatuses = latestStatusByDate(statuses).date;
      if (applied && fromStatuses) return applied > fromStatuses ? applied : fromStatuses;
      return applied || fromStatuses || null;
    }

    // Map by canonical key to merge case/spacing/legal-suffix variants
    const map = new Map<string, { display: string; latestAt: Date | null }>();

    for (const a of apps) {
      const rawName = (a.mi_name || "").trim();
      if (!rawName) continue;

      const key = canonCompanyKey(rawName);
      if (!key) continue;

      const pretty = prettifyCompanyName(rawName);
      const d = latestDateForApp(a);

      const current = map.get(key);
      if (!current) {
        map.set(key, { display: pretty, latestAt: d || null });
      } else {
        // Update latest date if this app is newer
        if (d && (!current.latestAt || d > current.latestAt)) {
          current.latestAt = d;
        }
        // Prefer prettier/longer display if we stored a worse variant
        if (pretty.length > current.display.length) {
          current.display = pretty;
        }
        map.set(key, current);
      }
    }

    const arr = Array.from(map.values());
    arr.sort((a, b) => {
      const ta = a.latestAt ? a.latestAt.getTime() : -Infinity;
      const tb = b.latestAt ? b.latestAt.getTime() : -Infinity;
      return tb - ta; // latest first
    });
    return arr;
  }, [apps, statusesByApp]);

  async function fetchStatusesFor(appId: string, strategy: "local-first" | "local-only" = "local-first") {
    const rawId = cleanAppId(appId);
    const key = canonId(rawId);

    // 1) Always try DB statuses table first (using application_id)
    try {
      const dbRows = await fetchStatusesFromDB(appId);
      if (dbRows !== null) {
        // We reached the DB endpoint successfully.
        if (dbRows.length > 0) {
          // Found timeline in DB — use it and stop here.
          setStatusesByApp((prev) => ({ ...prev, [key]: dbRows }));
          setTimelineLoaded((prev) => ({ ...prev, [key]: true }));
          setStatusDone((d) => d + 1);
          return;
        }
        // No rows in DB:
        if (strategy === "local-only") {
          // Respect "local-only": mark loaded with empty list and exit.
          setStatusesByApp((prev) => ({ ...prev, [key]: [] }));
          setTimelineLoaded((prev) => ({ ...prev, [key]: true }));
          setCachedStatuses(key, []);
          setStatusDone((d) => d + 1);
          return;
        }
        // For "local-first": fall through to remote fetch (government sources) to populate fresh.
        // Do not mark as loaded yet so the shimmer can continue until remote completes.
      }
    } catch {
      // Ignore DB errors and try the legacy path below.
    }

    // 2) Legacy path (local-first or remote) — backend decides whether to call TN.
    try {
      const r = await fetchWithTimeout(`${API_BASE}/api/search/application`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(localStorage.getItem("sla_token") ? { Authorization: `Bearer ${localStorage.getItem("sla_token")}` } : {}),
        },
        body: JSON.stringify({ appId: rawId, strategy }),
      });
      const json = await readJsonSafe(r);
      if (!r.ok || (json && json.ok === false)) {
        const msg = (json && (json.message || json.error)) || `Failed to fetch timeline (HTTP ${r.status})`;
        throw new Error(msg);
      }
      const items: StatusRow[] = Array.isArray(json?.statuses) ? json.statuses : [];
      setStatusesByApp((prev) => ({ ...prev, [key]: items }));
      setTimelineLoaded((prev) => ({ ...prev, [key]: true }));
      setStatusDone((d) => d + 1);
    } catch (e) {
      console.error("/api/search/application error:", e?.message || e);
      setStatusesByApp((prev) => ({ ...prev, [key]: [] }));
      setTimelineLoaded((prev) => ({ ...prev, [key]: true }));
      setStatusDone((d) => d + 1);
    }
  }

  // --- Helper functions for local result/placeholder handling ---
  function handleLocalResults(list: AppRow[], jsonLocal: any, appIdMode: boolean, clean: string) {
    const normalized = list.map(normalizeApp);
    setApps(normalized);
    setServerEmpty(false);
    clearProbeAndBanner();

    // If this was an Application-ID search and we already have a mobile (from DB payload),
    // expand to ALL applications for that mobile using LOCAL DB ONLY (no print/gov calls).
    (async () => {
      if (!appIdMode) return;
      const fromRowMobile = appIdMode
        ? normalized.find(a => canonId(a.application_id) === canonId(clean) && a.mobile && String(a.mobile).trim())?.mobile
        : normalized.find(a => a.mobile && String(a.mobile).trim())?.mobile;
      const fromMetaMobile = cleanStr(jsonLocal?.meta?.mobile);
      const mobileRaw = (fromRowMobile || fromMetaMobile || "").replace(/\D/g, "");
      if (!mobileRaw || mobileRaw.length < 10) return;

      try {
        const extraApps = await fetchAppsForMobileLocalOnly(mobileRaw);
        if (!extraApps.length) return;

        setApps(prev => {
          const before = prev || [];
          const merged = mergeApps(before, extraApps);

          // Fetch timelines for any newly added apps (strictly local-only for speed)
          const beforeIds = new Set(before.map(a => String(a.application_id)));
          const newIds = merged.map(a => String(a.application_id)).filter(id => !beforeIds.has(id));
          if (newIds.length) {
            setStatusTotal(t => Math.max(t, merged.length));
            (async () => {
              await Promise.all(newIds.map(id => fetchStatusesFor(id, "local-only")));
            })();
          }
          return merged;
        });
      } catch {
        // ignore expansion errors
      }
    })();

    const preCanon = extractPreCanon(jsonLocal);

    // Apply any prehydrated timelines from server and mark them as loaded (no browser cache)
if (Object.keys(preCanon).length) {
  setStatusesByApp(prev => ({ ...prev, ...preCanon }));
  setTimelineLoaded(prev => ({
    ...prev,
    ...Object.fromEntries(Object.keys(preCanon).map(k => [k, true])),
  }));
}

    // Ensure placeholders exist for all apps
    ensurePlaceholders(normalized);

    // Enrich missing District/Block/Village/Mobile only when missing (sequential; doesn’t block UI)
    (async () => {
      try {
        const ids = normalized.map(a => a.application_id);
        const known = appIdMode ? undefined : clean; // if searching by mobile, pass it along
        if (anyNeedsMeta(normalized)) {
          await enrichMetaForApps(ids, known);
        }
        // If new apps were added later via mobile enrichment (shouldn’t happen here, but safe-guard)
        const cur = appsRef.current || [];
        const pending = cur
          .map(a => a.application_id)
          .filter(id => {
            const key = canonId(id);
            const arr = statusesByApp[key];
            return !Array.isArray(arr) || arr.length === 0;
          });
        if (pending.length) {
          setStatusTotal(t => Math.max(t, pending.length));
          await Promise.all(pending.map(id => fetchStatusesFor(id, "local-first")));
        }
      } catch { /* ignore enrichment errors */ }
    })();

    // For any app that didn't come with a timeline from server or cache, fetch from LOCAL DB now (no banner)
    const pendingIds = normalized
    .map(a => a.application_id)
    .filter(id => {
      const key = canonId(id);
      const arr = preCanon[key];
      return !Array.isArray(arr) || arr.length === 0;
    });

    if (pendingIds.length > 0) {
      setStatusTotal(pendingIds.length);
      setStatusDone(0);
      setPhase("fetching-status");
      (async () => {
        await Promise.all(pendingIds.map(id => fetchStatusesFor(id, "local-first")));
        setPhase("done");
      })();
    } else {
      setPhase("done");
    }

    // For Application ID searches, only hit print if local DB lacks meta (district/block/village/mobile)
    if (appIdMode) {
      // Only hit print if we have NO mobile at all
      const noMobile = !normalized.some(a => a.mobile && String(a.mobile).trim());
      if (noMobile) {
        (async () => {
          try { await enrichFromPrintAndMaybeLoadMobileApps(clean); } catch { }
        })();
      }
    }

    setLoading(false);
  }

  function handlePlaceholderAppId(clean: string) {
    (async () => {
      const added = await enrichFromPrintAndMaybeLoadMobileApps(clean);
      if (added > 0) {
        // We already populated apps and started timeline fetches inside the enrichment path.
        clearProbeAndBanner();
        setPhase("done");
        setLoading(false);
        return;
      }
      // Fallback to existing placeholder logic if enrichment found nothing
      const placeholder = [{ application_id: clean, source: "local-db" } as AppRow];
      const normalized = placeholder.map(normalizeApp);
      setApps(normalized);
      setServerEmpty(false);
      clearProbeAndBanner();
      ensurePlaceholders(normalized);
      setStatusTotal(1);
      setStatusDone(0);
      // Immediately fetch timeline (local-first so DB is preferred, falls back to remote if needed)
      setPhase("fetching-status");
      (async () => {
        try {
          await fetchStatusesFor(clean, "local-first");
        } finally {
          setPhase("done");
        }
      })();
      setLoading(false);
    })();
    return;
  }

  function clearProbeAndBanner() {
    if (localProbeTimerRef.current) { clearTimeout(localProbeTimerRef.current); localProbeTimerRef.current = null; }
    if (bannerTimerRef.current) { clearTimeout(bannerTimerRef.current); bannerTimerRef.current = null; }
    setShowBanner(false);
  }

  function preHydrateTimelines(json: any, normalized: AppRow[]) {
    const preRaw = (json && (json.statusesByApp || json.timelines)) || null;
    if (preRaw && typeof preRaw === "object") {
      const map: Record<string, StatusRow[]> = {};
      for (const k of Object.keys(preRaw)) {
        const val = (preRaw as any)[k];
        if (Array.isArray(val)) map[canonId(k)] = val;
      }
      if (Object.keys(map).length) {
        setStatusesByApp(prev => ({ ...prev, ...map }));
        setTimelineLoaded(prev => ({ ...prev, ...Object.fromEntries(Object.keys(map).map(k => [k, true])) }));
      }
    }
  }

  function extractPreCanon(json: any): Record<string, StatusRow[]> {
    const preRaw = (json && (json.statusesByApp || json.timelines)) || null;
    const out: Record<string, StatusRow[]> = {};
    if (preRaw && typeof preRaw === "object") {
      for (const k of Object.keys(preRaw)) {
        const val = (preRaw as any)[k];
        if (Array.isArray(val)) out[canonId(k)] = val;
      }
    }
    return out;
  }

  function ensurePlaceholders(normalized: AppRow[]) {
    setStatusesByApp(prev => {
      const next = { ...prev };
      for (const a of normalized) {
        const key = canonId(a.application_id);
        if (next[key] === undefined) next[key] = [];
      }
      return next;
    });
  }

  async function onSearch(e: React.FormEvent) {
    e.preventDefault();
    // Bump key to clear previous results synchronously
    setSearchKey((k) => k + 1);
    hadLocalPrefillRef.current = false;
    lastQueryRef.current = null; // clear previous search
    // Start in "searching" but don't show the banner until we know it's a cache miss / pending
    setPhase("searching");
    setRotIdx(0);
    setStatusTotal(0);
    setStatusDone(0);
    setShowBanner(false);
    cachedHitRef.current = false;
    firstResponseRef.current = false;
    if (bannerTimerRef.current) {
      clearTimeout(bannerTimerRef.current);
      bannerTimerRef.current = null;
    }
    if (localProbeTimerRef.current) {
      clearTimeout(localProbeTimerRef.current);
      localProbeTimerRef.current = null;
    }

    activeReq.current += 1;
    const reqId = activeReq.current;

    setApps([]);
    setStatusesByApp({});
    setTimelineLoaded({});
    setHasSearched(true);
    setServerEmpty(false);
    setError(null);
    setLoading(true);
    // Clear any previous iframe viewer state when starting a new search
    setViewAppId(null);
    setIframeErr(null);

    const raw = String(number || "");
    const appIdMode = isAppIdLike(raw);
    const clean = appIdMode ? cleanAppId(raw) : digitsOnly(raw);

    try {
      const url = appIdMode ? `${API_BASE}/api/search/appid` : `${API_BASE}/api/search/number`;
      // If the local DB probe is slow, show the Searching… banner early so users get feedback.
      if (localProbeTimerRef.current) {
        clearTimeout(localProbeTimerRef.current);
        localProbeTimerRef.current = null;
      }
      localProbeTimerRef.current = setTimeout(() => {
        setShowBanner(true);
        setRotIdx(0);
      }, 1000);

      // 1) PROBE LOCAL DB ONLY – if results exist locally, render immediately and skip remote
      const probeBody = appIdMode
        ? { appId: clean, strategy: "local-only" }
        : { number: clean, strategy: "local-only" };
      const rLocal = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(probeBody),
        },
        60000
      );
      const jsonLocal = await readJsonSafe(rLocal);

      // Normalize local results (handle array/single and also related apps for appId searches)
      let localList: AppRow[] = [];
      if (rLocal.ok) {
        if (Array.isArray(jsonLocal?.applications)) {
          localList = jsonLocal.applications as AppRow[];
        } else if (jsonLocal?.application && typeof jsonLocal.application === "object") {
          localList = [jsonLocal.application as AppRow];
        } else if (appIdMode) {
          // Some backends return related apps (same mobile) when searching by appId
          const mobArr = Array.isArray(jsonLocal?.applications_from_mobile)
            ? jsonLocal.applications_from_mobile
            : [];
          if (mobArr.length > 0) {
            localList = mobArr.map((it: any) => ({
              application_id: cleanAppId(String(it?.application_id || clean)),
              crop_type: cleanStr(it?.crop_type ?? it?.crop_name),
              mi_name: cleanStr(it?.mi_name || it?.company_name),
              applied_date: cleanStr(it?.applied_date),
              farmer_name: cleanStr(
                it?.farmer_name ?? it?.farmer ?? it?.applicant_name
              ),
              mi_area: cleanNumber(
                it?.mi_area ?? it?.mi_hectare ?? it?.miarea ?? it?.mi
              ),
              total_area: cleanNumber(
                it?.total_area ?? it?.total_hectare ?? it?.hectare ?? it?.area
              ),
              survey_no: cleanStr(
                it?.survey_no ?? it?.survey ?? it?.survey_number
              ),
              subdivision_no: cleanStr(
                it?.subdivision_no ?? it?.sub_division_no ?? it?.subdivision
              ),
              farmer_type: cleanStr(it?.farmer_type),
              ss: cleanStr(it?.ss),
              source: "local-db",
              mobile: cleanStr(jsonLocal?.meta?.mobile),
              aadhaar: undefined,
            } as AppRow));
            // Make searched app (if present) appear first, then sort by applied_date desc
            localList.sort((a, b) => {
              const aIs = String(a.application_id) === clean ? -1 : 0;
              const bIs = String(b.application_id) === clean ? -1 : 0;
              if (aIs !== bIs) return aIs - bIs; // searched app first
              const ad = parseDateLoose(a.applied_date || "");
              const bd = parseDateLoose(b.applied_date || "");
              const at = ad ? ad.getTime() : -Infinity;
              const bt = bd ? bd.getTime() : -Infinity;
              return bt - at; // newest first otherwise
            });
          }
        }
      }

      // For Application ID search, if nothing found locally, seed a placeholder and do NOT proceed to remote.
      if (appIdMode && localList.length === 0) {
        handlePlaceholderAppId(clean);
        return;
      }
      // For mobile search (appIdMode === false), if localList.length === 0, fall through to remote fetch below.
      if (localList.length > 0) {
        handleLocalResults(localList, jsonLocal, appIdMode, clean);
        return;
      }

      // 2) REMOTE (LOCAL-FIRST) – schedule banner now because we're going to the network
      firstResponseRef.current = false;
      if (bannerTimerRef.current) { clearTimeout(bannerTimerRef.current); bannerTimerRef.current = null; }
      // show immediately for remote searches
      setShowBanner(true);
      setRotIdx(0);
      if (localProbeTimerRef.current) {
        clearTimeout(localProbeTimerRef.current);
        localProbeTimerRef.current = null;
      }

      const body = appIdMode
        ? { appId: clean, strategy: "local-first" }
        : { number: clean, strategy: "local-first" };

      // Remember this query so the poller effect can re-fetch while results trickle in
      lastQueryRef.current = { url, body, appIdMode };

      const r = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
        },
        120000
      );
      firstResponseRef.current = true;
      if (bannerTimerRef.current) { clearTimeout(bannerTimerRef.current); bannerTimerRef.current = null; }
      const json = await readJsonSafe(r);

      if (!r.ok || (json && json.ok === false)) {
        const msg = (json && (json.message || json.error)) || "";
        const notFoundish = r.status === 404 || /not\s*found|no\s*data|no\s*records/i.test(msg);
        if (notFoundish) {
          if (reqId !== activeReq.current) return;
          setPhase("done");
          setShowBanner(false);
          setServerEmpty(true);
          setApps([]);
          return;
        }
        throw new Error(msg || `Search failed (HTTP ${r.status})`);
      }

      if (json?.cached === true) {
        cachedHitRef.current = true;
        if (bannerTimerRef.current) {
          clearTimeout(bannerTimerRef.current);
          bannerTimerRef.current = null;
        }
        // Served list from cache — hide the slow-source banner here; phase will be decided later
        setShowBanner(false);
      }

      // Normalize applications list
      let list: AppRow[] = [];
      if (Array.isArray(json?.applications)) {
        list = json.applications as AppRow[];
      } else if (json?.application && typeof json.application === "object") {
        list = [json.application as AppRow];
      } else if (appIdMode) {
        // --- When searching by Application ID, show ALL apps found for the discovered mobile/Aadhaar ---
        const appId = clean; // the cleaned Application ID we searched for
        const mobArr = Array.isArray(json?.applications_from_mobile)
          ? json.applications_from_mobile
          : [];

        // Map every returned application to AppRow, tagging with the discovered mobile from meta
        const mapped: AppRow[] = mobArr.map((it: any) => ({
          application_id: String(it?.application_id || appId),
          crop_type: cleanStr(it?.crop_type ?? it?.crop_name),
          mi_name: cleanStr(it?.mi_name || it?.company_name),
          applied_date: cleanStr(it?.applied_date),
          farmer_name: cleanStr(
            it?.farmer_name ?? it?.farmer ?? it?.applicant_name
          ),
          mi_area: cleanNumber(
            it?.mi_area ?? it?.mi_hectare ?? it?.miarea ?? it?.mi
          ),
          total_area: cleanNumber(
            it?.total_area ?? it?.total_hectare ?? it?.hectare ?? it?.area
          ),
          survey_no: cleanStr(
            it?.survey_no ?? it?.survey ?? it?.survey_number
          ),
          subdivision_no: cleanStr(
            it?.subdivision_no ?? it?.sub_division_no ?? it?.subdivision
          ),
          farmer_type: cleanStr(it?.farmer_type),
          ss: cleanStr(it?.ss),
          source: "tn-print",
          mobile: cleanStr(json?.meta?.mobile),
          aadhaar: undefined,
        }));

        if (mapped.length === 0) {
          // Fallback: if nothing came back, at least render the searched app id
          list = [{
            application_id: appId,
            source: "tn-print",
            mobile: cleanStr(json?.meta?.mobile),
          }];
        } else {
          // Sort so the searched app (if present) appears first, then by applied_date (desc) when possible.
          list = mapped.sort((a, b) => {
            const aIs = String(a.application_id) === appId ? -1 : 0;
            const bIs = String(b.application_id) === appId ? -1 : 0;
            if (aIs !== bIs) return aIs - bIs; // searched app first

            const ad = parseDateLoose(a.applied_date || "");
            const bd = parseDateLoose(b.applied_date || "");
            const at = ad ? ad.getTime() : -Infinity;
            const bt = bd ? bd.getTime() : -Infinity;
            return bt - at; // newest first otherwise
          });
        }
      }

      if (reqId !== activeReq.current) return;

      const normalized = list.map(normalizeApp);
      setApps(normalized);
      // Ensure immediate display and fetch timelines (local DB first, then government if needed)
      ensurePlaceholders(normalized);
      setStatusTotal(normalized.length);
      setStatusDone(0);
      setPhase("fetching-status");
      (async () => {
        try {
          await Promise.all(normalized.map(a => fetchStatusesFor(a.application_id, "local-first")));
        } finally {
          setPhase("done");
        }
      })();
      // statusesByApp is only hydrated from backend response (statusesByApp/timelines) below
      setServerEmpty(normalized.length === 0);
      // Try to enrich meta for all apps shown (fetches District/Block/Village/Mobile from print if missing)
      const allIds = normalized.map(a => a.application_id);
      (async () => {
        try {
          if (anyNeedsMeta(normalized)) {
            const ids = normalized.map(a => a.application_id);
            const known = appIdMode ? undefined : clean;
            await enrichMetaForApps(ids, known);
          }
        } catch { /* ignore enrichment errors */ }
      })();

      // If we already displayed local results, suppress any subsequent banners
      if (hadLocalPrefillRef.current) {
        setPhase("done");
        setShowBanner(false);
        if (bannerTimerRef.current) { clearTimeout(bannerTimerRef.current); bannerTimerRef.current = null; }
      }
      // Phase/banner
      if (normalized.length === 0) {
        setPhase("done");
        setShowBanner(false);
        if (bannerTimerRef.current) { clearTimeout(bannerTimerRef.current); bannerTimerRef.current = null; }
      } else if (json?.cached === false) {
        setPhase("cache-miss");
        if (bannerTimerRef.current) { clearTimeout(bannerTimerRef.current); bannerTimerRef.current = null; }
        setRotIdx(0);
        // Don't show banner yet; only show if there are pending remote fetches (computed below)
      } else if (json?.cached === true) {
        // Application IDs were served from our DB cache.
        // Do NOT touch browser cache; fetch timelines strictly from local DB.
        setStatusTotal(allIds.length);
        setPhase("fetching-status");
        await Promise.all(allIds.map((id) => fetchStatusesFor(id, "local-only")));
        setPhase("done");
        setShowBanner(false);
        if (bannerTimerRef.current) { clearTimeout(bannerTimerRef.current); bannerTimerRef.current = null; }
      } else {
        // leave banner state unchanged (some sources don't return a `cached` flag)
      }

      // Pre-hydrate timelines if backend sent them (canonicalized keys)
      // Pre-hydrate timelines if backend sent them (canonicalized keys)
      {
        const preRaw =
          (json && (json.statusesByApp || json.timelines)) ||
          (appIdMode && Array.isArray(json?.statuses) ? { [clean]: json.statuses } : null);

        let preCanon: Record<string, StatusRow[]> = {};
        if (preRaw && typeof preRaw === "object") {
          for (const k of Object.keys(preRaw)) {
            const val = (preRaw as any)[k];
            if (Array.isArray(val)) preCanon[canonId(k)] = val;
          }
        }

        if (Object.keys(preCanon).length) {
          const map: Record<string, StatusRow[]> = {};
          const loaded: Record<string, boolean> = {};
          for (const a of normalized) {
            const key = canonId(a.application_id);
            const arr = preCanon[key];
            if (Array.isArray(arr)) {
              map[key] = arr;
              loaded[key] = true; // mark as loaded
            }
          }
          if (Object.keys(map).length) {
            setStatusesByApp((prev) => ({ ...prev, ...map }));
            setTimelineLoaded((prev) => ({ ...prev, ...loaded }));
          }

          const readyCount = Object.keys(map).length; // server-prehydrated only
          setStatusTotal(normalized.length);
          setStatusDone(readyCount);
          if (readyCount === normalized.length) {
            cachedHitRef.current = true; // treat as DB/local result
          }
        }

        // After merging any server-sent timelines, seed placeholders only for the remaining apps
        setStatusesByApp((prev) => {
          const next = { ...prev } as Record<string, StatusRow[]>;
          for (const a of normalized) {
            const key = canonId(a.application_id);
            if (next[key] === undefined) next[key] = [];
          }
          return next;
        });

        // If searching by Application ID and the server sent a single timeline, seed it now
        if (appIdMode && Array.isArray(json?.statuses) && normalized.length === 1) {
          const appKey = canonId(normalized[0].application_id);
          const items = json.statuses as StatusRow[];
          setStatusesByApp((prev) => ({ ...prev, [appKey]: items }));
          setTimelineLoaded((prev) => ({ ...prev, [appKey]: true }));
          // Reflect seeded timeline in progress immediately
          setStatusTotal((t) => Math.max(t, 1));
          setStatusDone((d) => Math.max(d, 1));
        }

        const statusStrategy: "local-first" = "local-first";
        // Mark if a seeded single-app timeline was sent (so we can skip it in pending fetches)
        const seededFromSingle = appIdMode && Array.isArray(json?.statuses) && normalized.length === 1;
        const seededAppKey = seededFromSingle ? normalized[0].application_id : undefined;

        const allIds = normalized.map((a) => a.application_id);
        const pendingIds = allIds.filter((id) => {
          const key = canonId(id);
          const fromServer = preCanon[key];
          const hasServer = Array.isArray(fromServer) && fromServer.length > 0;
          return !hasServer && id !== seededAppKey;
        });

        if (json?.cached !== true && pendingIds.length > 0) {
          setStatusTotal(pendingIds.length);
          setPhase("fetching-status");
          (async () => {
            await Promise.all(pendingIds.map((id) => fetchStatusesFor(id, statusStrategy)));
          })();
          // Do NOT show banner during timeline fetches
          setShowBanner(false);
        } else if (json?.cached !== true && pendingIds.length === 0) {
          setPhase("done");
          setShowBanner(false);
          if (bannerTimerRef.current) {
            clearTimeout(bannerTimerRef.current);
            bannerTimerRef.current = null;
          }
        }
      }
    } catch (err) {
      if (reqId !== activeReq.current) return;
      if (bannerTimerRef.current) { clearTimeout(bannerTimerRef.current); bannerTimerRef.current = null; }
      if (localProbeTimerRef.current) {
        clearTimeout(localProbeTimerRef.current);
        localProbeTimerRef.current = null;
      }
      setShowBanner(false);

      const msg = err?.message ? String(err.message) : "";
      const isAbortOrTimeout =
        err?.name === "AbortError" ||
        err?.code === "ETIMEDOUT" ||
        /aborted|abort|timed\s*out/i.test(msg);

      if (isAbortOrTimeout) {
        // Silent cancel/timeout: do not surface as an error toast/banner.
        setPhase("done");
        setError(null);
        setApps([]);
      } else if (/not\s*found|no\s*data|no\s*records/i.test(msg)) {
        setPhase("done");
        setServerEmpty(true);
        setError(null);
        setApps([]);
      } else {
        setPhase("done");
        setError(msg ? `Search error: ${msg}` : "Unable to fetch info");
        setApps([]);
      }
    } finally {
      if (reqId === activeReq.current) setLoading(false);
      if (reqId === activeReq.current && phase === "done") {
        if (bannerTimerRef.current) { clearTimeout(bannerTimerRef.current); bannerTimerRef.current = null; }
        if (localProbeTimerRef.current) {
          clearTimeout(localProbeTimerRef.current);
          localProbeTimerRef.current = null;
        }
        setShowBanner(false);
      }
    }
  }

  return (
    <div className="max-w-7xl mx-auto p-6">
      {/* local styles */}<ShimmerStyles />
      {/* Search */}
      <Card title="Fetch Farmer Info" subtitle="Search using Aadhaar, Mobile number, or Application ID" className="mb-6 shadow-lg">
        <form ref={formRef} onSubmit={onSearch} className="flex gap-4 items-center">
          <Input
            placeholder="Enter Aadhaar / Mobile / Application ID"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            onKeyDown={(e: any) => {
              if (e.key === "Enter") {
                e.preventDefault();
                const f = formRef.current;
                if (f) {
                  const rs: any = (f as any).requestSubmit;
                  if (typeof rs === "function") rs.call(f);
                  else f.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
                }
              }
            }}
            className="rounded-lg border border-gray-300 focus:ring-2 focus:ring-green-500 focus:outline-none placeholder-gray-400 px-4 py-2 flex-grow"
          />
          <Button
            type="submit"
            disabled={loading}
            className="bg-gradient-to-r from-green-500 to-emerald-600 text-white font-semibold rounded-lg px-6 py-2 transform transition-transform duration-300 hover:scale-105 shadow-md disabled:opacity-60"
          >
            Search
          </Button>
        </form>
        {error && <div className="mt-3 text-sm text-rose-600">{error}</div>}
      </Card>

      {/* Progressive status banner for slow TN APIs */}
      {showBanner && (phase !== "idle" && phase !== "done") && (
        <div className="mb-6 rounded-xl border border-amber-200/70 bg-amber-50 text-amber-900 dark:border-amber-700/50 dark:bg-amber-900/20 dark:text-amber-200 px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-amber-500 animate-pulse" />
            <span className="font-medium">
              {rotatingPhrases[rotIdx]}
            </span>
          </div>
          {phase === "fetching-status" && statusTotal > 0 && (
            <div className="text-sm">
              {Math.min(statusDone, statusTotal)} / {statusTotal}
            </div>
          )}
        </div>
      )}

      {/* Aggregates / Graphics */}
      {(phase === "searching" || phase === "cache-miss" || phase === "fetching-status" || phase === "done") && apps.length > 0 && aggregates && (
        <Card key={`agg-${searchKey}`} className="mb-8 shadow-md">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-stretch">
            {/* Completion / Eligibility banner */}
            {completionSummary && (
              <div className="lg:col-span-3 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <DateIcon className="h-5 w-5 text-emerald-600" />
                  <div>
                    <div className="text-xs text-slate-500">Last Work Order Completion</div>
                    <div className="text-base font-semibold text-slate-900 dark:text-slate-100">
                      {fmtDate(completionSummary.completedAt)}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {completionSummary.eligibleNow ? (
                    <span className="inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ring-1 bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300">Eligible</span>
                  ) : (
                    <>
                      <span className="inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ring-1 bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-500/10 dark:text-rose-300">Not Eligible</span>
                      <span
                        className={
                          `inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold ring-1 ` +
                          (completionSummary.counterTone === 'red'
                            ? 'bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-500/10 dark:text-rose-300'
                            : completionSummary.counterTone === 'green'
                              ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300'
                              : 'bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300'
                          )
                        }
                        title="Days until 7 years from completion"
                      >
                        {Math.max(0, completionSummary.daysLeft)} days remaining
                      </span>
                    </>
                  )}
                </div>
              </div>
            )}
            {/* Per-survey eligibility table */}
            {perSurveyEligibility.length > 0 && (
              <div className="lg:col-span-3 -mt-1">
                <div className="mt-4 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden bg-white dark:bg-slate-800">
                  <div className="px-4 py-3 text-sm font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-2">
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 6h18M3 12h18M3 18h18" /></svg>
                    Survey No - Eligibility
                  </div>
                  <div>
                    <table className="min-w-full text-sm">
                      <thead className="bg-slate-50 dark:bg-slate-900/40 text-slate-600 dark:text-slate-300">
                        <tr>
                          <th className="text-left px-4 py-2 font-medium">Survey</th>
                          <th className="text-left px-4 py-2 font-medium">Completed on</th>
                          <th className="text-left px-4 py-2 font-medium">Next due (7y)</th>
                          <th className="text-left px-4 py-2 font-medium">Status</th>
                          <th className="text-left px-4 py-2 font-medium">Days remaining</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                        {perSurveyEligibility.map((sv) => {
                          const completedStr = fmtDate(sv.completedAt);
                          const nextDue = sv.completedAt ? addYears(sv.completedAt, 7) : null;
                          const nextDueStr = fmtDate(nextDue);
                          const statusBadgeClass = sv.eligibleNow
                            ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300"
                            : sv.counterTone === "red"
                              ? "bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-500/10 dark:text-rose-300"
                              : sv.counterTone === "green"
                                ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300"
                                : "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300";
                          const statusText = sv.eligibleNow ? "Eligible" : "Not Eligible";
                          return (
                            <tr key={sv.survey} className="text-slate-800 dark:text-slate-200">
                              <td className="px-4 py-2 whitespace-nowrap font-medium">{"" + sv.survey}</td>
                              <td className="px-4 py-2">{completedStr}</td>
                              <td className="px-4 py-2">{nextDueStr}</td>
                              <td className="px-4 py-2">
                                <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadgeClass}`}>
                                  {statusText}
                                </span>
                              </td>
                              <td className="px-4 py-2">
                                {sv.eligibleNow ? "0" : Math.max(0, sv.daysLeft)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
            {/* Left: Stats tiles */}
            <div className="h-full">
              <div className="h-full rounded-xl border border-slate-200 p-4 bg-white dark:bg-slate-800 flex flex-col justify-between">
                <div className="flex items-center gap-2 text-slate-500 text-xs font-medium uppercase tracking-wide"><IdIcon className="h-4 w-4" />Applications</div>
                <div className="mt-1 text-2xl font-bold text-slate-900 dark:text-slate-100">{fmtInt(apps.length)}</div>
              </div>
            </div>

            {/* Middle: Farmer summary (when consistent) */}
            <div className="h-full rounded-2xl border border-slate-200 p-4 bg-gradient-to-br from-emerald-50 to-white dark:from-slate-800 dark:to-slate-900">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full grid place-items-center bg-emerald-500/10 text-emerald-600"><FarmerIcon className="h-5 w-5" /></div>
                <div>
                  <div className="text-sm text-slate-500">Farmer</div>
                  <div className="text-base font-semibold text-slate-900 dark:text-slate-100">
                    {uniq(apps.map(a => a.farmer_name || "").filter(Boolean)).join(", ") || "—"}
                  </div>
                  {/* Mobile number (first non-empty) */}
                  {apps.some(a => a.mobile) && (
                    <div className="text-xs text-slate-500 flex items-center gap-1 mt-0.5">
                      <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
                        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.08 6.18 2 2 0 0 1 4 4h3a2 2 0 0 1 2 1.72c.12.81.37 1.6.72 2.33a2 2 0 0 1-.45 2.18l-1.27 1.27a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.18-.45c.73.35 1.52.6 2.33.72A2 2 0 0 1 20 16.92h2z"/>
                      </svg>
                      {apps.find(a => a.mobile)?.mobile}
                    </div>
                  )}
                  {aggregates.latestApplied ? (
                    <div className="text-xs text-slate-500 flex items-center gap-1 mt-0.5"><DateIcon className="h-3.5 w-3.5" />Last applied: {fmtDate(new Date(aggregates.latestApplied))}</div>
                  ) : null}
                </div>
              </div>
            </div>

            {/* New: Global MI vs Total Pie */}
            <div className="h-full flex flex-col items-center justify-center">
              <div className="relative h-32 w-32 rounded-full" style={globalAreaStyle} aria-label="MI vs Total Area">
                <div className="absolute inset-4 rounded-full bg-white dark:bg-slate-900 grid place-items-center">
                  <div className="text-center">
                    <div className="text-xs text-slate-500">MI / Total</div>
                    <div className="text-lg font-bold text-slate-900 dark:text-slate-100">{fmtArea(aggregates.totalMI)}</div>
                    <div className="text-xs text-slate-400">of {fmtArea(aggregates.totalArea)}</div>
                  </div>
                </div>
              </div>
              <div className="flex gap-3 mt-2 text-xs items-center">
                <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-500 mr-1" />
                <span>MI Area</span>
                <span className="inline-block h-2.5 w-2.5 rounded-full bg-slate-200 dark:bg-slate-600 ml-4 mr-1" />
                <span>Remaining</span>
              </div>
            </div>

            {/* District / Block / Village summary (above Companies preferred) */}
            {(locationSummary.districts.length > 0 || locationSummary.blocks.length > 0 || locationSummary.villages.length > 0) && (
              <div className="lg:col-span-3 -mt-1">
                <div className="mt-4 rounded-xl border border-slate-200 dark:border-slate-700 overflow-hidden bg-white dark:bg-slate-800">
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-sm">
                      <thead className="bg-slate-50 dark:bg-slate-900/40 text-slate-600 dark:text-slate-300">
                        <tr>
                          <th className="text-left px-4 py-2 font-medium">District</th>
                          <th className="text-left px-4 py-2 font-medium">Block</th>
                          <th className="text-left px-4 py-2 font-medium">Village</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-200 dark:divide-slate-700">
                        <tr className="text-slate-800 dark:text-slate-200">
                          <td className="px-4 py-2 align-top">
                            {locationSummary.districts.length ? locationSummary.districts.join(", ") : "—"}
                          </td>
                          <td className="px-4 py-2 align-top">
                            {locationSummary.blocks.length ? locationSummary.blocks.join(", ") : "—"}
                          </td>
                          <td className="px-4 py-2 align-top">
                            {locationSummary.villages.length ? locationSummary.villages.join(", ") : "—"}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {/* Companies preferred by Farmer (latest first) */}
            {companiesPreferred.length > 0 && (
              <div className="lg:col-span-3 mt-2">
                <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4">
                  <div className="flex items-center gap-2 text-slate-500 text-xs font-medium uppercase tracking-wide">
                    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 12h18M3 6h18M3 18h18" /></svg>
                    Companies preferred by farmer
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {companiesPreferred.map((c) => (
                      <span
                        key={c.display}
                        className="inline-flex items-center gap-2 rounded-full border border-emerald-200/70 dark:border-emerald-700/50 bg-emerald-50/60 dark:bg-emerald-900/10 px-3 py-1 text-sm text-emerald-800 dark:text-emerald-200"
                        title={c.latestAt ? `Latest activity: ${c.latestAt.toLocaleString()}` : undefined}
                      >
                        <span className="font-semibold truncate max-w-[14rem]">{c.display}</span>
                        {c.latestAt && (
                          <span className="text-[11px] text-emerald-700/70 dark:text-emerald-300/70">
                            {fmtDate(c.latestAt)}
                          </span>
                        )}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </Card>
      )}

      {/* Applications list */}
      {(phase === "searching" || phase === "cache-miss" || phase === "fetching-status" || phase === "done") && apps.length > 0 && (
        <div key={`list-${searchKey}`} className="grid grid-cols-1 xl:grid-cols-2 gap-x-10 gap-y-8 mb-10">
          {apps.map((a) => {
            const appKey = canonId(a.application_id);
            const statuses = statusesByApp[appKey];
            // Normalize and sort by actual timestamp (handles formats like "22-09-2023 12:04:17 PM")
            // Sort DESCENDING by actual timestamp (latest first). Undated items (NEG_INF) go last.
            // Stable: preserve original order when timestamps are equal.
            const sortedStatuses: StatusRow[] | undefined = Array.isArray(statuses)
              ? [...statuses]
                .map((s, idx) => {
                  const d = parseDateLoose(s?.status_date);
                  const ts = d ? d.getTime() : Number.NEGATIVE_INFINITY; // undated -> last
                  return { s, idx, ts } as any;
                })
                .sort((a: any, b: any) => {
                  if (a.ts !== b.ts) return b.ts - a.ts; // newest first
                  return a.idx - b.idx;                  // stable for equal timestamps
                })
                .map((x: any) => x.s as StatusRow)
              : undefined;
            // ---- Compute completed status/date, next due, days left ----
            let finalItem: StatusRow | undefined = undefined;
            if (sortedStatuses && sortedStatuses.length) {
              const bestCompleted = latestStatusByDateWhere(
                sortedStatuses,
                (row) => typeof row.status === "string" && /(complete|commission|install)/i.test(row.status as string)
              );
              if (bestCompleted.item) {
                finalItem = bestCompleted.item;
              } else {
                finalItem = latestStatusByDate(sortedStatuses).item;
              }
            }
            const completedAt: Date | null = finalItem?.status_date ? parseDateLoose(finalItem.status_date) : null;
            let nextDue: Date | null = null;
            let daysLeft: number | null = null;
            if (completedAt) {
              nextDue = addYears(completedAt, 7);
              daysLeft = daysBetweenUTC(new Date(), nextDue);
            }
            const completedAtStr = fmtDate(completedAt);
            // ---- Area pie for this app ----
            const ratio = a.total_area && a.total_area > 0 ? Math.min(1, Math.max(0, (a.mi_area || 0) / a.total_area)) : null;
            const miArea = a.mi_area || 0;
            const totalArea = a.total_area || 0;
            const restArea = Math.max(0, totalArea - miArea);
            const sumArea = miArea + restArea || 1;
            const miDeg = (miArea / sumArea) * 360;
            const appAreaStyle: React.CSSProperties | undefined =
              ratio != null
                ? {
                  background: `conic-gradient(#10b981 0deg ${miDeg}deg, #e5e7eb ${miDeg}deg 360deg)`,
                }
                : undefined;
            // Latest status = first dated row in DESC list; fallback to a.ss
            const latestFromSorted: StatusRow | undefined =
              sortedStatuses?.find(s => !!parseDateLoose(String(s.status_date))) || (sortedStatuses?.[0]);
            const latestStatus = (latestFromSorted?.status as string | undefined) ?? a.ss ?? undefined;
            return (
              <Card key={a.application_id} className="shadow-md p-4 flex flex-col gap-3">
                {/* Application ID band (premium header) */}
                <div className="mb-6 relative overflow-hidden rounded-2xl border border-emerald-200 dark:border-emerald-700 bg-gradient-to-br from-emerald-50/80 via-white to-emerald-50/60 dark:from-emerald-900/10 dark:via-slate-900 dark:to-emerald-900/5 p-4 shadow-[0_8px_24px_rgba(16,185,129,.15)] ring-1 ring-emerald-500/10">
                  <div className="flex items-start gap-4">
                    <div className="h-9 w-9 flex-shrink-0 grid place-items-center rounded-xl bg-emerald-600/10 text-emerald-700 dark:text-emerald-300">
                      <IdIcon className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] uppercase tracking-wider text-emerald-800/80 dark:text-emerald-300/80 font-semibold">Application ID</div>
                      <div
                        className="mt-0.5 font-mono text-sm sm:text-base tracking-wide text-slate-900 dark:text-slate-100 truncate select-all"
                        data-testid="application-id"
                        aria-label="Application ID"
                      >
                        {String(a.application_id || "—")}
                      </div>
                      {latestStatus && (
                        <div className="mt-1 flex items-center gap-2">
                          <span className="text-[10px] uppercase tracking-wide text-emerald-900/70 dark:text-emerald-200/70">Status</span>
                          <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold bg-emerald-50 text-emerald-700 ring-1 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 max-w-full truncate">
                            <StatusDot />{latestStatus}
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setViewAppId(String(a.application_id || ""))}
                        title="View Application"
                        aria-label="View Application"
                        className="rounded-xl border border-emerald-200 dark:border-emerald-700 bg-white/80 dark:bg-slate-900/70 hover:bg-white dark:hover:bg-slate-800 transition-colors px-3 h-9 text-sm font-semibold text-emerald-700 dark:text-emerald-300"
                      >
                        View
                      </button>

                      <button
                        type="button"
                        onClick={() => copyAppId(String(a.application_id || ""))}
                        title="Copy Application ID"
                        aria-label="Copy Application ID"
                        className="grid h-9 w-9 place-items-center rounded-xl border border-emerald-200 dark:border-emerald-700 bg-white/80 dark:bg-slate-900/70 hover:bg-white dark:hover:bg-slate-800 transition-colors"
                      >
                        {copiedAppId === a.application_id
                          ? <CheckIcon className="h-4 w-4 text-emerald-600 dark:text-emerald-300" />
                          : <CopyIcon className="h-4 w-4 text-emerald-700 dark:text-emerald-300" />
                        }
                      </button>
                    </div>
                  </div>
                  {/* Subline: last update or loading */}
                  <div className="mt-2 flex items-center gap-3 text-[11px] text-emerald-900/80 dark:text-emerald-200/80">
                    {(() => {
                      const appKey = canonId(a.application_id);
                      const s = sortedStatuses;

                      // If we already have statuses, show them immediately
                      if (Array.isArray(s) && s.length > 0) {
                        const firstDated = s.find(it => !!parseDateLoose(String(it?.status_date)));
                        const last = firstDated ? parseDateLoose(String(firstDated.status_date)) : null;
                        return last ? (
                          <span className="inline-flex items-center gap-2">
                            <DateIcon className="h-3.5 w-3.5" />
                            <span>Last update: {fmtDate(last)} • {timeAgo(last)}</span>
                          </span>
                        ) : null;
                      }

                      // Otherwise, only show shimmer if not yet loaded
                      if (!timelineLoaded[appKey]) {
                        return (
                          <span className="inline-flex items-center gap-2">
                            <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                            <span className="relative inline-block overflow-hidden rounded-full bg-emerald-100/60 dark:bg-emerald-900/30 px-2 py-0.5">
                              <span className="absolute inset-0 -translate-x-full animate-[shimmer_1.5s_infinite] bg-gradient-to-r from-transparent via-white/60 to-transparent dark:via-white/10" />
                              Fetching status…
                            </span>
                          </span>
                        );
                      }

                      const firstDated = (s as StatusRow[] | undefined)?.find(it => !!parseDateLoose(String(it?.status_date)));
                      const last = firstDated ? parseDateLoose(String(firstDated.status_date)) : null;

                      return last ? (
                        <span className="inline-flex items-center gap-2">
                          <DateIcon className="h-3.5 w-3.5" />
                          <span>Last update: {fmtDate(last)} • {timeAgo(last)}</span>
                        </span>
                      ) : null;
                    })()}
                  </div>
                  <div className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-emerald-500/40 to-transparent" />
                </div>
                <div className="mt-2 mb-2 border-t border-slate-200 dark:border-slate-700" />

                {/* Meta grid */}
                <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                  <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300"><FarmerIcon className="h-4 w-4" />{a.farmer_name || "—"}</div>
                  <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300"><LeafIcon className="h-4 w-4" />{a.crop_type || "—"}</div>
                  {a.applied_date ? (
                    <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300"><DateIcon className="h-4 w-4" />{a.applied_date}</div>
                  ) : (
                    // Always render placeholder for spacing
                    <div className="flex items-center gap-2 text-slate-700 dark:text-slate-300" style={{ visibility: "hidden" }}>
                      <DateIcon className="h-4 w-4" />{"—"}
                    </div>
                  )}
                </div>

                {/* Area Pie + Details */}
                <div className="mt-5 grid grid-cols-2 gap-4 items-center">
                  {/* Left: Mini Pie */}
                  <div className="flex flex-col items-start">
                    <div className="relative h-20 w-20 rounded-full" style={appAreaStyle} aria-label="MI vs Total Area">
                      <div className="absolute inset-3 rounded-full bg-white dark:bg-slate-900 grid place-items-center">
                        <div className="text-xs font-semibold text-slate-900 dark:text-slate-100 text-center leading-tight">
                          {fmtArea(a.mi_area)}<br /><span className="text-slate-400">/ {fmtArea(a.total_area)}</span>
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-1 mt-1 text-xs items-center">
                      <span className="inline-block h-2 w-2 rounded-full bg-emerald-500 mr-1" />
                      <span>MI</span>
                      <span className="inline-block h-2 w-2 rounded-full bg-slate-200 dark:bg-slate-600 ml-2 mr-1" />
                      <span>Rem</span>
                    </div>
                  </div>
                  {/* Right: Key details with icons */}
                  <div className="flex flex-col gap-1 text-xs">
                    <div className="flex items-center gap-1 text-slate-700 dark:text-slate-300">
                      <FactoryIcon className="h-4 w-4" /><span className="font-medium">Company:</span> <span className="ml-1 truncate">{a.mi_name || "—"}</span>
                    </div>
                    <div className="flex items-center gap-1 text-slate-700 dark:text-slate-300">
                      <TypeIcon className="h-4 w-4" /><span className="font-medium">Farmer Type:</span> <span className="ml-1">{a.farmer_type || "—"}</span>
                    </div>
                    <div className="flex items-center gap-1 text-slate-700 dark:text-slate-300">
                      <PinIcon className="h-4 w-4" /><span className="font-medium">Survey:</span> <span className="ml-1">{a.survey_no || "—"}</span>
                    </div>
                    <div className="flex items-center gap-1 text-slate-700 dark:text-slate-300">
                      <PinIcon className="h-4 w-4" /><span className="font-medium">Sub Div:</span> <span className="ml-1">{a.subdivision_no || "—"}</span>
                    </div>
                    <div className="flex gap-1 mt-1">
                      <span className="inline-flex items-center rounded-full bg-emerald-50 text-emerald-700 px-2 py-0.5 text-xs font-semibold ring-1 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300">
                        Total: {fmtArea(a.total_area)}
                      </span>
                      <span className="inline-flex items-center rounded-full bg-emerald-100 text-emerald-700 px-2 py-0.5 text-xs font-semibold ring-1 ring-emerald-600/20 dark:bg-emerald-500/20 dark:text-emerald-200">
                        MI: {fmtArea(a.mi_area)}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="mt-5 border-t border-slate-200 dark:border-slate-700" />
                {/* Timeline */}
                <div className="mt-6">
                  {(() => {
                    const key = canonId(a.application_id);
                    const loaded = !!timelineLoaded[key];
                    if (!loaded) {
                      return (
                        <div className="text-sm text-amber-700 dark:text-amber-300 flex items-center gap-2">
                          <span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
                          <span className="relative inline-block overflow-hidden rounded-full bg-amber-50/70 dark:bg-amber-900/20 px-2 py-0.5">
                            <span className="absolute inset-0 -translate-x-full animate-[shimmer_1.5s_infinite] bg-gradient-to-r from-transparent via-white/50 to-transparent dark:via-white/10" />
                            Fetching info…
                          </span>
                        </div>
                      );
                    }
                    // Request finished: show the timeline if we have items, otherwise show a clear empty state
                    return sortedStatuses && sortedStatuses.length > 0 ? (
                      <Timeline items={sortedStatuses} />
                    ) : (
                      <div className="text-sm text-gray-500">No timeline yet.</div>
                    );
                  })()}
                </div>

              </Card>
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {phase === "done" && !loading && apps.length === 0 && !error && (
        <div className="text-sm text-gray-500 grid place-items-center py-16">
          {hasSearched && serverEmpty ? (
            <div className="text-center">
              <svg viewBox="0 0 64 64" className="mx-auto h-16 w-16 text-slate-300"><circle cx="32" cy="32" r="30" stroke="currentColor" fill="none" /><path d="M20 24h24M20 32h18M20 40h12" stroke="currentColor" /></svg>
              <div className="mt-3 text-base text-slate-600">Farmer hasn't used the services.</div>
            </div>
          ) : (
            <div className="text-center">
              <svg viewBox="0 0 64 64" className="mx-auto h-16 w-16 text-slate-300"><circle cx="28" cy="28" r="12" stroke="currentColor" fill="none" /><path d="M44 44l12 12" stroke="currentColor" /></svg>
              <div className="mt-3 text-base text-slate-600">Enter a Mobile/Aadhaar number (10–12 digits) or an Application ID and press Search.</div>
            </div>
          )}
        </div>
      )}
      {/* Modal/Overlay for viewing application */}
      {viewAppId && (
        <div className="fixed inset-0 z-[100]">
          {/* Backdrop - clicking closes the viewer */}
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setViewAppId(null)}
          />

          {/* Modal container */}
          <div
            className="absolute inset-4 md:inset-10 bg-white dark:bg-slate-900 rounded-xl shadow-2xl overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-slate-200 dark:border-slate-700">
              <div className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                Application: {viewAppId}
              </div>
              <button
                type="button"
                onClick={() => setViewAppId(null)}
                className="rounded-md border border-slate-300 dark:border-slate-700 px-2 py-1 text-xs hover:bg-slate-100 dark:hover:bg-slate-800"
                aria-label="Close viewer"
                title="Close"
              >
                Close
              </button>
            </div>
            <div className="flex-1 flex items-center justify-center overflow-auto">
              {iframeErr ? (
                <div className="p-4 text-sm text-rose-700 bg-rose-50 rounded-md border border-rose-200">
                  {iframeErr}.{" "}
                  <a
                    href={viewAppId ? `${API_BASE}/api/tn-print/${encodeURIComponent(String(viewAppId))}` : '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline font-semibold"
                  >
                    Open in new tab
                  </a>
                </div>
              ) : (
                <iframe
                  ref={iframeRef}
                  src="about:blank"
                  className="w-[80%] h-[80%] max-w-full max-h-full border-none"
                />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}