import React, { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";

// ---- API base (same pattern as Login) ----
const API_BASE = (() => {
    // 1) Explicit env / window config wins
    const envUrl = (import.meta as any)?.env?.VITE_API_URL || (window as any).__API_URL__ || "";
    const explicit = String(envUrl || "").trim().replace(/\/+$/, "");
    if (explicit) return explicit;

    // 2) Dev fallback: if running on Vite (e.g., http://localhost:5173), default to hitting the Node server port
    try {
        const loc = window.location;
        const host = (loc.hostname || "").toLowerCase();
        const isLocal = host === "localhost" || host === "127.0.0.1";
        if (isLocal) {
            const port = (import.meta as any)?.env?.VITE_API_PORT || "8081"; // override with VITE_API_PORT if provided
            return `http://localhost:${String(port).trim()}`;
        }
    } catch { /* ignore if window isn't available */ }

    // 3) Last resort: same-origin (assumes a reverse-proxy is in place)
    try {
        return (window.location.origin || "").replace(/\/+$/, "");
    } catch { }

    return ""; // caller will build relative URLs
})();

if (typeof console !== "undefined") {
    console.info("[BulkJobs] API_BASE=", API_BASE || "<relative>");
}

/** Wrapper that prefixes API_BASE and forces JSON by default (and disables browser cache) */
function apiFetch(path: string, init: RequestInit = {}) {
    const url = `${API_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
    const base: RequestInit = {
        cache: "no-store",
        headers: {
            // callers can override/extend
            ...(init.headers || {}),
        },
    };
    return fetch(url, { ...base, ...init, headers: { ...(base.headers || {}), ...(init.headers || {}) } });
}

// Utility to get creator name from localStorage (strict reader of sla_user.name)
function getCreatedBy(): string {
    try {
        const raw = localStorage.getItem("sla_user");
        if (!raw) return "";
        const obj = JSON.parse(raw);
        const name = typeof obj?.name === "string" ? obj.name.trim() : "";
        return name;
    } catch {
        return "";
    }
}


/**
 * BulkJobs
 * - Upload an Excel file (xlsx/xls/csv)
 * - Let user pick which COLUMN to read numbers from (defaults to first)
 * - Detect Mobile (10 digits) vs Aadhaar (12 digits)
 * - Process each number via existing backend: POST /api/search/number { number }
 * - Nice progress UI with counts, live status list, and export results
 *
 * NOTE: Uses dynamic import('xlsx') so page loads even if the lib isn't preloaded.
 * Make sure you have it installed:  npm i xlsx
 */

type ItemStatus = "pending" | "processing" | "ok" | "error";

type ResultRow = {
    number: string;
    kind: "mobile" | "aadhaar" | "application" | "unknown";
    status: ItemStatus;
    message?: string;
    response?: any;
};

// Classification rules (updated):
// - If exactly 12 digits: Aadhaar (regardless of leading digits)
// - If exactly 10 digits: Mobile
// - If more than 10 digits and last 10 are valid: Mobile (country/leading zero)
// - If matches application ID pattern: application
// - Else: invalid
function classifyAny(raw: string): { kind: "mobile" | "aadhaar" | "application" | "invalid"; normalized?: string } {
    const s = (raw || "").trim();
    const digits = s.replace(/\D/g, "");
    if (!digits && !s) return { kind: "invalid" };

    // Application ID: alphanumeric (with -), at least 8 chars, must contain at least one letter and one digit
    if (/^[a-zA-Z0-9\-]{8,}$/.test(s) && /[a-zA-Z]/.test(s) && /\d/.test(s)) {
        return { kind: "application", normalized: s };
    }

    // 12 digits -> Aadhaar (do this FIRST to avoid stripping "91" from Aadhaar that begins with 91)
    if (digits.length === 12) {
        return { kind: "aadhaar", normalized: digits };
    }

    // Plain 10-digit -> Mobile
    if (digits.length === 10) {
        return { kind: "mobile", normalized: digits };
    }

    // If not exactly 10 digits, only consider as mobile when the *original* input starts with +91, 91 or 0
    // Then take the last 10 digits.
    const startsWithKnownMobilePrefix =
        s.startsWith("+91") || s.startsWith("91") || s.startsWith("0");

    if (startsWithKnownMobilePrefix && digits.length > 10) {
        const last10 = digits.slice(-10);
        if (/^\d{10}$/.test(last10)) {
            return { kind: "mobile", normalized: last10 };
        }
    }

    return { kind: "invalid" };
}

// Infer kind from a raw number string if backend doesn't provide it (updated logic)
function inferKindFromDigits(num: string): "mobile" | "aadhaar" | "application" | "unknown" {
    const s = (num || "").trim();
    const d = s.replace(/\D/g, "");
    // Application ID: alphanumeric (with -), at least 8 chars, must contain at least one letter and one digit
    if (/^[a-zA-Z0-9\-]{8,}$/.test(s) && /[a-zA-Z]/.test(s) && /\d/.test(s)) return "application";
    if (!d) return "unknown";
    if (d.length === 12) return "aadhaar";
    if (d.length === 10) return "mobile";
    if (d.length > 10 && /^\d{10}$/.test(d.slice(-10))) return "mobile";
    return "unknown";
}

// ---- App normalizer (accepts legacy keys) ----
function normalizeAppRow(it: any) {
    if (!it) return null;
    const get = (k: any, ...alts: any[]) => {
        const v = k ?? (alts.find((a) => a != null) ?? null);
        return v;
    };
    const crop_type = String(get(it.crop_type, it.crop_name, it.cropType) ?? "").trim() || null;
    const mi_name = String(get(it.mi_name, it.company_name, it.miName) ?? "").trim() || null;
    const applied_date = String(get(it.applied_date, it.appliedDate) ?? "").trim() || null;
    const farmer_name = String(get(it.farmer_name, it.farmer, it.applicant_name, it.applicantName) ?? "").trim() || null;
    const toNum = (x: any) => {
        const n = Number(x);
        return Number.isFinite(n) ? n : null;
    };
    const mi_area = toNum(get(it.mi_area, it.mi_hectare, it.miarea, it.mi));
    const total_area = toNum(get(it.total_area, it.total_hectare, it.hectare, it.area));
    const survey_no = String(get(it.survey_no, it.survey, it.survey_number) ?? "").trim() || null;
    const subdivision_no = String(get(it.subdivision_no, it.sub_division_no, it.subdivision) ?? "").trim() || null;
    const farmer_type = String(get(it.farmer_type, it.farmerType) ?? "").trim() || null;
    const ss = String(get(it.ss, it.status_summary, it.latest_status) ?? "").trim() || null;
    const application_id = String(get(it.application_id, it.appId, it.applicationId, it.id) ?? "").trim() || null;
    return { application_id, crop_type, mi_name, applied_date, farmer_name, mi_area, total_area, survey_no, subdivision_no, farmer_type, ss };
}

function appRowToInlineMessage(app: any) {
    if (!app) return "";
    const parts: string[] = [];
    if (app.application_id) parts.push(`#${app.application_id}`);
    if (app.farmer_name) parts.push(app.farmer_name);
    if (app.crop_type) parts.push(app.crop_type);
    if (app.mi_name) parts.push(app.mi_name);
    const areaBits: string[] = [];
    if (Number.isFinite(app.mi_area)) areaBits.push(`MI ${app.mi_area}`);
    if (Number.isFinite(app.total_area)) areaBits.push(`Tot ${app.total_area}`);
    if (areaBits.length) parts.push(areaBits.join(" · "));
    const svy = [app.survey_no, app.subdivision_no].filter(Boolean).join(" / ");
    if (svy) parts.push(svy);
    if (app.farmer_type) parts.push(app.farmer_type);
    // Do not include SS in inline message
    return parts.filter(Boolean).join(" • ");
}

function extractPrimaryAppFromResponse(json: any) {
    if (!json) return null;
    // If we already received a single application-like object (preview), normalize it directly
    const looksLikeApp = (obj: any) => !!(obj && (
        obj.application_id || obj.appId || obj.applicationId || obj.id ||
        obj.crop_type || obj.crop_name || obj.farmer_name || obj.survey_no
    ));
    if (looksLikeApp(json)) {
        return normalizeAppRow(json);
    }
    // Typical shapes
    const apps = Array.isArray(json?.applications) ? json.applications : [];
    if (apps.length > 0) return normalizeAppRow(apps[0]);
    if (json?.application && looksLikeApp(json.application)) return normalizeAppRow(json.application);
    return null;
}

// ---- Helpers: fetch TN Print and extract Mobile (client-side) ----
function extractMobileFromPrintHTML(html: string): string | null {
    if (!html) return null;
    // Look for patterns like "Mobile", "Mobile No", "Mobile Number" followed by digits
    const patterns: RegExp[] = [
        /Mobile\s*(?:No\.?|Number)?\s*[:\-]?\s*([+\d][\d\s-]{9,})/i,
        /Phone\s*(?:No\.?|Number)?\s*[:\-]?\s*([+\d][\d\s-]{9,})/i,
        /Contact\s*(?:No\.?|Number)?\s*[:\-]?\s*([+\d][\d\s-]{9,})/i,
    ];
    for (const re of patterns) {
        const m = html.match(re);
        if (m && m[1]) {
            const digits = m[1].replace(/\D/g, "");
            const last10 = digits.slice(-10);
            if (/^\d{10}$/.test(last10)) return last10;
        }
    }
    // Table-based: <td>Mobile</td><td>XXXXXXXXXX</td>
    const tdRe = /<td[^>]*>\s*Mobile[^<]*<\/td>\s*<td[^>]*>\s*([^<]+)\s*<\/td>/i;
    const tdm = html.match(tdRe);
    if (tdm && tdm[1]) {
        const digits = tdm[1].replace(/\D/g, "");
        const last10 = digits.slice(-10);
        if (/^\d{10}$/.test(last10)) return last10;
    }
    return null;
}

async function fetchMobileViaPrint(appId: string): Promise<string | null> {
    try {
        const r = await apiFetch(`/api/tn-print/${encodeURIComponent(appId)}`, { headers: { Accept: "text/html" } });
        if (!r.ok) {
            // Treat upstream 4xx/5xx as "no mobile available"; do not bubble 500 into the UI.
            try { await r.text(); } catch { }
            return null;
        }
        const html = await r.text();
        if (!html) return null;
        return extractMobileFromPrintHTML(html);
    } catch { return null; }
}

// ---- Client-side enrichment for Server Jobs items ----
const _enriching = new Set<string>();
async function enrichRowFromLocal(
    number: string,
    update: (num: string, patch: Partial<ResultRow> | ((curr?: ResultRow) => Partial<ResultRow>)) => void
) {
    if (!number || _enriching.has(number)) return; // de-dupe
    _enriching.add(number);
    try {
        const token = localStorage.getItem("sla_token");
        const kindGuess = classifyAny(number).kind;

        // If this looks like an Application ID, try Print -> Mobile -> Local-first number search
        if (kindGuess === "application") {
            // Do not alter message in Job Status
            return; // success (no UI message change)
        }

        // Else: treat as Mobile/Aadhaar — just pull local-only and enrich
        // Do not alter message in Job Status for number lookups
        return;
    } catch { /* ignore */ }
    finally { _enriching.delete(number); }
}

// --- Local DB probe for Application ID statuses (no remote) ---
async function probeAppIdLocal(appid: string, token: string | null): Promise<{ found: boolean; json?: any }> {
    const headers: any = {
        "Accept": "application/json",
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    try {
        const r = await apiFetch("/api/search/application", {
            method: "POST",
            headers,
            body: JSON.stringify({ appId: appid, strategy: "local-only" }),
        });
        const ct = (r.headers.get("content-type") || "").toLowerCase();
        const json = ct.includes("application/json") ? await r.json() : null;
        if (!r.ok) return { found: false, json };
        // STRICT: Only treat as a local hit if backend explicitly marked it as cached
        const cached = json?.cached === true;
        return { found: cached, json };
    } catch {
        return { found: false };
    }
}

const formatAadhaar = (s: string) => {
    const d = s.replace(/\D/g, "");
    return d.replace(/(\d{4})(?=\d)/g, "$1 ");
};
const formatMobile = (s: string) => s.replace(/\D/g, "");

// Strict mobile normalizer: always last 10 digits (used by backend lookups)
function normalizeMobile10(input: string): string {
    const d = (input || "").replace(/\D/g, "");
    return d.slice(-10); // canonical 10-digit mobile key used by backend lookups
}

// Strict aadhaar normalizer: always 12 digits (last 12 kept in case of stray prefixes)
function normalizeAadhaar12(input: string): string {
    const d = (input || "").replace(/\D/g, "");
    return d.slice(-12);
  }

// Convert a JS number (possibly displayed in scientific notation) into a plain integer string
function numberToPlainString(n: number): string {
    try {
        // Try SSF if available (xlsx provides this for proper Excel-style formatting)
        // Format as integer with no separators
        // @ts-ignore
        if (XLSX?.SSF && typeof XLSX.SSF.format === "function") {
            // Using a long zero mask to avoid any grouping or decimals
            const s = XLSX.SSF.format("0", n);
            if (s && /^\d+$/.test(s)) return s;
        }
    } catch { }
    try {
        // Modern engines: fullwide avoids scientific notation and grouping
        const s = (n as any).toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 0 });
        if (s && /^\d+$/.test(s)) return s;
    } catch { }
    // Manual fallback for "mantissa e exponent"
    const raw = String(n);
    if (/e/i.test(raw)) {
        const [mantissa, expStr] = raw.toLowerCase().split("e");
        const exp = parseInt(expStr || "0", 10) || 0;
        const [intPart, fracPart = ""] = mantissa.split(".");
        if (exp >= 0) {
            // shift decimal right
            const combined = intPart + fracPart;
            const needZeros = exp - fracPart.length;
            if (needZeros > 0) return combined + "0".repeat(needZeros);
            return combined.slice(0, intPart.length + exp);
        } else {
            // shift decimal left
            const zeros = "0".repeat(Math.max(0, Math.abs(exp) - 1));
            return "0" + zeros + intPart + fracPart;
        }
    }
    // Last resort: truncate any decimals and remove non-digits
    return String(Math.trunc(n)).replace(/\D/g, "");
}

// Parse a scientific-notation STRING to a plain digits string without using Number()
function sciStrToPlainDigits(s: string): string {
    const m = s.trim().toLowerCase();
    if (!/e[+-]?\d+/.test(m)) return m.replace(/[^\d]/g, "");
    const [mant, expStr] = m.split("e");
    const exp = parseInt(expStr || "0", 10) || 0;
    const parts = mant.split(".");
    const intp = parts[0].replace("-", "");
    const frac = parts[1] || "";
    if (exp >= 0) {
        const combined = intp + frac;
        const needZeros = exp - frac.length;
        return (needZeros > 0 ? combined + "0".repeat(needZeros) : combined.slice(0, intp.length + exp)).replace(/[^\d]/g, "");
    } else {
        // 1.23e-3 -> 0.00123 -> digits "000123" then trim leading zeros later
        const zeros = "0".repeat(Math.max(0, Math.abs(exp) - 1));
        const merged = "0" + zeros + intp + frac;
        return merged.replace(/[^\d]/g, "");
    }
}

// Normalize any Excel cell value to a clean digits-only string (no spaces, dashes, etc.)
function normalizeExcelCellToDigits(cell: any): string {
    if (!cell) return "";
    const v = cell.v;
    // Prefer underlying raw value; `w` may be truncated by Excel display formats
    if (typeof v === "number" && isFinite(v)) {
        return numberToPlainString(v).replace(/[^\d]/g, "");
    }
    if (typeof v === "string") {
        const str = v.trim();
        if (/e[+-]?\d+/i.test(str)) return sciStrToPlainDigits(str);
        return str.replace(/[^\d]/g, "");
    }
    // fallback to displayed text
    const w = cell.w != null ? String(cell.w) : "";
    if (/e[+-]?\d+/i.test(w)) return sciStrToPlainDigits(w);
    return w.replace(/[^\d]/g, "");
}

// Concurrency & rate limiting
// Defaults target ~500 items/minute with a safe default concurrency.
const DEFAULT_CONCURRENCY = 12;
const MAX_CONCURRENCY = (() => {
    try {
        const fromLS = Number(localStorage.getItem("sla_bulk_concurrency") || "");
        if (Number.isFinite(fromLS) && fromLS > 0) return Math.min(fromLS, 64);
    } catch { }
    return DEFAULT_CONCURRENCY;
})();
const DEFAULT_ITEMS_PER_MIN = 500;
const ITEMS_PER_MIN = (() => {
    try {
        const fromLS = Number(localStorage.getItem("sla_bulk_ipm") || "");
        if (Number.isFinite(fromLS) && fromLS > 0) return Math.min(fromLS, 3000);
    } catch { }
    return DEFAULT_ITEMS_PER_MIN;
})();
const MIN_GAP_MS = Math.max(0, Math.floor(60000 / ITEMS_PER_MIN)); // min ms between request starts

const BulkJobs: React.FC = () => {
    const [file, setFile] = useState<File | null>(null);
    const [sheetNames, setSheetNames] = useState<string[]>([]);
    const [activeSheet, setActiveSheet] = useState<string | null>(null);
    const [columns, setColumns] = useState<string[]>([]);
    const [selectedCol, setSelectedCol] = useState<string | null>(null);

    const [rows, setRows] = useState<ResultRow[]>([]);
    const [parsing, setParsing] = useState(false);
    const [parseError, setParseError] = useState<string | null>(null);

    const [processing, setProcessing] = useState(false);
    const [progress, setProgress] = useState({ total: 0, done: 0, ok: 0, error: 0 });
    const [startedAt, setStartedAt] = useState<number | null>(null);
    const abortRef = useRef<boolean>(false);
    const lastLaunchRef = useRef<number>(0);
    const lastServerActionRef = useRef<null | 'cancel' | 'delete'>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);
const [fileInputKey, setFileInputKey] = useState(0);

    // --- Server mode additions ---
    const [serverMode, setServerMode] = useState(true);
    const [jobId, setJobId] = useState<string | null>(null);
    const LS_JOB_KEY = "sla_bulk_last_job";
    const LS_PROGRESS_KEY = "sla_bulk_last_progress";
    const LS_SUPPRESS_VIEW = "sla_bulk_suppress_view"; // epoch ms until which auto-view is disabled

    function setSuppressAutoView(minutes = 15) {
        try {
            const until = Date.now() + minutes * 60_000;
            localStorage.setItem(LS_SUPPRESS_VIEW, String(until));
        } catch { }
    }
    function clearSuppressAutoView() {
        try { localStorage.removeItem(LS_SUPPRESS_VIEW); } catch { }
    }
    function isAutoViewSuppressed(): boolean {
        try {
            const raw = localStorage.getItem(LS_SUPPRESS_VIEW);
            if (!raw) return false;
            const until = parseInt(raw, 10) || 0;
            if (until <= 0) return false;
            if (Date.now() > until) { localStorage.removeItem(LS_SUPPRESS_VIEW); return false; }
            return true;
        } catch { return false; }
    }
    const [createdBy, setCreatedBy] = useState<string>("");

    function saveSnapshot(
        id: string | null,
        prog: { total: number; done: number; ok: number; error: number },
        rowsSnap: ResultRow[]
    ) {
        try {
            if (!id) return;
            const snap = { jobId: id, progress: prog, rows: rowsSnap, ts: Date.now() };
            localStorage.setItem(LS_PROGRESS_KEY, JSON.stringify(snap));
        } catch { }
    }

    function tryRestoreSnapshot(id: string | null) {
        try {
            if (!id) return false;
            const raw = localStorage.getItem(LS_PROGRESS_KEY);
            if (!raw) return false;
            const snap = JSON.parse(raw);
            if (!snap || snap.jobId !== id) return false;
            if (snap.progress) setProgress(snap.progress);
            if (Array.isArray(snap.rows)) setRows(snap.rows);
            return true;
        } catch {
            return false;
        }
    }

    // --- helpers ---
    function resetAll() {
        setSheetNames([]);
        setActiveSheet(null);
        setColumns([]);
        setSelectedCol(null);
        setRows([]);
        setParseError(null);
        setProcessing(false);
        setProgress({ total: 0, done: 0, ok: 0, error: 0 });
        setStartedAt(null);
        abortRef.current = false;
        setJobId(null); // stop viewing any server job when starting fresh
    }

    async function onFilePicked(f?: File | null) {
        // User picked a file — switch to a fresh local session and stop viewing server job
        if (fileInputRef.current) {
            try { fileInputRef.current.value = ''; } catch {}
        }
        setFileInputKey((k) => k + 1);
        setJobId(null);
        setProcessing(false);
        resetAll();
        if (!f) return;
        setFile(f);
        setParsing(true);
        setParseError(null);
        try {
            console.info("[BulkJobs] Parsing file:", f?.name);
            const buf = await f.arrayBuffer();
            const wb = XLSX.read(buf, { type: "array" });

            const names = wb.SheetNames || [];
            setSheetNames(names);
            const firstName = names[0];
            setActiveSheet(firstName || null);

            if (!firstName) throw new Error("No sheets found in file.");

            const ws = wb.Sheets[firstName];
            const aoa: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false });

            // Build columns from header row (row 1) OR synthesize A,B,C...
            const headerRow = (aoa[0] || []) as string[];
            const cols =
                headerRow.length > 0
                    ? headerRow.map((h, i) => (h && String(h).trim() ? String(h).trim() : `Column ${i + 1}`))
                    : Array.from({ length: Math.max(...aoa.map((r) => r.length)) || 1 }, (_, i) => `Column ${i + 1}`);

            setColumns(cols);
            setSelectedCol(cols[0] || null);
            // Preview support removed
            console.info("[BulkJobs] XLSX loaded, using sheet:", firstName);
        } catch (e: any) {
            console.error("[BulkJobs] File parse error:", e);
            setParseError(e?.message || "Failed to parse the file.");
        } finally {
            setParsing(false);
        }
    }

    // Reads numbers from the selected column (entire sheet, robust against Excel formatting/scientific notation)
    const extractedNumbers = useMemo(() => {
        if (!file || !selectedCol || !columns.length) return [] as Promise<string[]>;
        let colIdx = columns.indexOf(selectedCol);
        if (colIdx < 0) return [] as Promise<string[]>;

        return (async () => {
            try {
                const buf = await file.arrayBuffer();
                const wb = XLSX.read(buf, { type: "array", cellText: true, cellNF: true, cellDates: true, raw: true });
                const ws = wb.Sheets[activeSheet || wb.SheetNames[0]];
                if (!ws) return [] as string[];

                const ref = ws["!ref"];
                if (!ref) return [] as string[];
                const range = XLSX.utils.decode_range(ref);

                const values: string[] = [];
                const colLetter = XLSX.utils.encode_col(colIdx);

                // start from the second row to skip header
                for (let r = range.s.r + 1; r <= range.e.r; r++) {
                    const addr = `${colLetter}${r + 1}`;
                    const cell: any = ws[addr];
                    if (!cell) continue;

                    // skip header-like literal "Numbers"
                    const wStrRaw = cell.w != null ? String(cell.w).trim() : "";
                    if (wStrRaw.toLowerCase() === "numbers") continue;

                    // Preserve original string/value for correct prefix detection (+91/91/0)
                    let originalStr = wStrRaw;
                    if (!originalStr) {
                        if (typeof cell.v === "number" && isFinite(cell.v)) {
                            // render number without scientific notation
                            originalStr = numberToPlainString(cell.v);
                        } else if (cell.v != null) {
                            originalStr = String(cell.v);
                        }
                    }

                    // If the original looks like scientific notation text, expand it
                    if (/e[+-]?\d+/i.test(originalStr)) {
                        originalStr = sciStrToPlainDigits(originalStr);
                    }

                    const cls = classifyAny(originalStr);
                    if (cls.kind !== "invalid" && cls.normalized) {
                        values.push(cls.normalized);
                    }
                }

                const seen = new Set<string>();
                const uniq: string[] = [];
                for (const n of values) {
                    if (!seen.has(n)) {
                        seen.add(n);
                        uniq.push(n);
                    }
                }
                return uniq;
            } catch {
                return [] as string[];
            }
        })();
    }, [file, activeSheet, selectedCol, columns]);

    const [numbers, setNumbers] = useState<string[]>([]);
    useEffect(() => {
        let mounted = true;
        (async () => {
            const list = await extractedNumbers;
            if (mounted) setNumbers(list);
        })();
        return () => {
            mounted = false;
        };
    }, [extractedNumbers]);

    useEffect(() => {
        const seed: ResultRow[] = numbers.map((n) => {
            const cls = classifyAny(n);
            return {
                number: cls.normalized || n,
                kind: cls.kind === "invalid" ? "unknown" : cls.kind,
                status: "pending",
            };
        });
        setRows(seed);
        setProgress({ total: seed.length, done: 0, ok: 0, error: 0 });
    }, [numbers]);

    // Memoized detected counts for the Detected items card
    const detectedCounts = useMemo(() => {
        let mobile = 0, aadhaar = 0, application = 0, unknown = 0;
        for (const n of numbers) {
            const { kind } = classifyAny(n);
            if (kind === "mobile") mobile++;
            else if (kind === "aadhaar") aadhaar++;
            else if (kind === "application") application++;
            else unknown++;
        }
        return { mobile, aadhaar, application, unknown };
    }, [numbers]);

    // Robust AppID search: try multiple payload shapes/endpoints to accommodate backend variations
    async function fetchAppIdWithFallbacks(appid: string, token: string | null): Promise<Response> {
        const commonHeaders: any = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        };
        const attempts: Array<{ method?: string; path: string; body?: any }> = [
            // Prefer the unified application endpoint; let backend do DB-first using strategy
            { path: "/api/search/application", body: { appId: appid, strategy: "local-first" } },
            { path: "/api/search/application", body: { application_id: appid, strategy: "local-first" } },
            { path: "/api/search/application", body: { applicationId: appid, strategy: "local-first" } },
            { path: "/api/search/application", body: { id: appid, strategy: "local-first" } },
            // As a last resort, allow GET with strategy=local-first so backend can still prefer cache DB
            { method: "GET", path: `/api/search/application?appId=${encodeURIComponent(appid)}&strategy=local-first` },
        ];
        let lastErrText = "";
        for (const a of attempts) {
            try {
                const init: RequestInit = {
                    method: a.method || "POST",
                    headers: commonHeaders,
                };
                if (!a.method || a.method === "POST") {
                    init.body = JSON.stringify(a.body ?? {});
                }
                const r = await apiFetch(a.path, { cache: "no-store", ...init });
                // Prefer JSON responses and HTTP 2xx
                const ok = r.ok;
                const ct = (r.headers.get("content-type") || "").toLowerCase();
                if (ok && ct.includes("application/json")) return r;
                // If backend responded non-JSON 2xx, still return it (caller will handle)
                if (ok) return r;
                // For 4xx, keep trying next variants
                if (r.status >= 400 && r.status < 500) {
                    try { lastErrText = await r.text(); } catch { /* ignore */ }
                    continue;
                }
                // For 5xx or network-like, break and return immediately
                return r;
            } catch (e: any) {
                lastErrText = e?.message || String(e);
                continue;
            }
        }
        // Construct a synthetic 400-like Response to surface diagnostic
        return new Response(JSON.stringify({ ok: false, message: lastErrText || "All AppID payload variants failed" }), {
            status: 400,
            headers: { "Content-Type": "application/json" }
        });
    }

    // Probe local cache (DB) for a number (mobile/aadhaar) without calling TN
    async function localProbeHasData(raw: string): Promise<boolean> {
        try {
            const digits = (raw || "").replace(/\D/g, "");
            const normalized = digits.length === 10 ? normalizeMobile10(digits) : normalizeAadhaar12(digits);
            const token = localStorage.getItem("sla_token");
            const r = await apiFetch("/api/search/number", {
                method: "POST",
                headers: {
                    "Accept": "application/json",
                    "Content-Type": "application/json",
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
                body: JSON.stringify({ number: normalized, strategy: "local-only" }),
            });
            if (!r.ok) return false;
            const j = await r.json().catch(() => ({}));
            const apps = Array.isArray(j?.applications) ? j.applications : [];
            const statuses = Array.isArray(j?.statuses) ? j.statuses : [];
            return Boolean(j?.cached === true || apps.length > 0 || statuses.length > 0);
        } catch { return false; }
    }

    // Try to start a server job for Application IDs so they persist in /jobs and survive refresh
    async function tryStartServerJobForApplications(appIds: string[]): Promise<{ ok: boolean; jobId?: string; message?: string }> {
        if (!appIds?.length) return { ok: false, message: "No Application IDs provided" };
        const token = localStorage.getItem("sla_token");
        const headers: any = { "Accept": "application/json", "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
        const created_by = getCreatedBy();
        // Build customJobId: Excel filename (no extension) + date + time
        const now = new Date();
        const datePart = now.toISOString().slice(0, 10); // YYYY-MM-DD
        const timePart = now.toTimeString().split(" ")[0].replace(/:/g, "-"); // HH-MM-SS
        const baseName = file?.name ? file.name.replace(/\.[^.]+$/, "") : "Job";
        const customJobId = `${baseName}_${datePart}_${timePart}`;
        // Try a combined route first (if server was updated to accept appIds), then a dedicated appid route.
        const attempts: Array<{ path: string; body: any; method?: string }> = [
            { path: "/api/bulk/start", body: { appIds, created_by, jobId: customJobId } },
            { path: "/api/bulk/start-appid", body: { appIds, created_by, jobId: customJobId } },
            { path: "/api/bulk/start-appids", body: { appIds, created_by, jobId: customJobId } },
        ];
        for (const a of attempts) {
            try {
                const r = await apiFetch(a.path, { method: a.method || "POST", headers, body: JSON.stringify(a.body) });
                const ct = (r.headers.get("content-type") || "").toLowerCase();
                if (!r.ok) {
                    // try next variant on 4xx; break on 5xx
                    if (r.status >= 500) {
                        const t = await r.text().catch(() => "");
                        return { ok: false, message: (t || `HTTP ${r.status}`) };
                    }
                    continue;
                }
                if (!ct.includes("application/json")) {
                    // Non-JSON means probably a proxy redirect; try next
                    continue;
                }
                const json = await r.json().catch(() => ({} as any));
                if (json && json.ok !== false) {
                    const id = json.jobId || json.id || json.job?.id;
                    if (id) return { ok: true, jobId: String(id) };
                    // Some servers might return an array of jobs; pick first id
                    const arr = Array.isArray(json.jobs) ? json.jobs : [];
                    const firstId = arr.length ? (arr[0].id || arr[0].jobId) : null;
                    if (firstId) return { ok: true, jobId: String(firstId) };
                    return { ok: false, message: "Missing jobId in response" };
                }
                return { ok: false, message: json?.message || "Failed to start server job for appIds" };
            } catch (e: any) {
                // try next attempt
                continue;
            }
        }
        return { ok: false, message: "Server does not support Application ID jobs; falling back to client." };
    }

    // Try to start a server job for numbers/aadhaar (only these kinds are sent to backend)
    async function tryStartServerJobForNumbers(rowsIn: ResultRow[]): Promise<{ ok: boolean; jobId?: string; message?: string }> {
        if (!rowsIn?.length) return { ok: false, message: "No items" };
        // Always enqueue all numbers (no local prefilter)
        const onlyNumbers: string[] = rowsIn
            .filter(r => r.kind === "mobile" || r.kind === "aadhaar")
            .map(r => (r.kind === "mobile" ? normalizeMobile10(r.number) : normalizeAadhaar12(r.number)));
        if (!onlyNumbers.length) return { ok: false, message: "No mobile/Aadhaar items" };

        const token = localStorage.getItem("sla_token");
        const headers: any = { "Accept": "application/json", "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
        const created_by = getCreatedBy();
        // Build customJobId: Excel filename (no extension) + date + time
        const now = new Date();
        const datePart = now.toISOString().slice(0, 10); // YYYY-MM-DD
        const timePart = now.toTimeString().split(" ")[0].replace(/:/g, "-"); // HH-MM-SS
        const baseName = file?.name ? file.name.replace(/\.[^.]+$/, "") : "Job";
        const customJobId = `${baseName}_${datePart}_${timePart}`;

        // Backend contract: /api/bulk/start { numbers: string[], created_by, jobId }
        try {
            const r = await apiFetch("/api/bulk/start", { method: "POST", headers, body: JSON.stringify({ numbers: onlyNumbers, created_by, jobId: customJobId }) });
            const ct = (r.headers.get("content-type") || "").toLowerCase();
            if (!r.ok) {
                const text = await r.text().catch(() => "");
                const first200 = (text || "").slice(0, 200);
                return { ok: false, message: first200 || `HTTP ${r.status}` };
            }
            if (!ct.includes("application/json")) {
                return { ok: false, message: `Non-JSON response from /api/bulk/start (status ${r.status})` };
            }
            const json = await r.json().catch(() => ({}));
            if (json && json.ok !== false) {
                const id = json.jobId || json.id || json.job?.id;
                if (id) return { ok: true, jobId: String(id) };
                return { ok: false, message: "Missing jobId in response" };
            }
            return { ok: false, message: json?.message || "Failed to start server job" };
        } catch (e: any) {
            return { ok: false, message: e?.message || "Network error starting server job" };
        }
    }

    // Start a single server job for BOTH numbers and appIds in one request (ensures a job is always created)
    async function startServerJobAll(rowsIn: ResultRow[]): Promise<{ ok: boolean; jobId?: string; message?: string }> {
        if (!rowsIn?.length) return { ok: false, message: "No items" };
        // Always enqueue all numbers and appIds (no local prefilter)
        const numbers = rowsIn
            .filter(r => r.kind === "mobile" || r.kind === "aadhaar")
            .map(r => (r.kind === "mobile" ? normalizeMobile10(r.number) : normalizeAadhaar12(r.number)));
        const appIds = rowsIn
            .filter(r => r.kind === "application")
            .map(r => r.number);
        if (!numbers.length && !appIds.length) return { ok: false, message: "No items to enqueue" };

        const token = localStorage.getItem("sla_token");
        const headers: any = { "Accept": "application/json", "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
        const created_by = getCreatedBy();
        // Build customJobId: Excel filename (no extension) + date + time
        const now = new Date();
        const datePart = now.toISOString().slice(0, 10); // YYYY-MM-DD
        const timePart = now.toTimeString().split(" ")[0].replace(/:/g, "-"); // HH-MM-SS
        const baseName = file?.name ? file.name.replace(/\.[^.]+$/, "") : "Job";
        const customJobId = `${baseName}_${datePart}_${timePart}`;
        try {
            const payload: any = { created_by, jobId: customJobId };
            if (numbers.length) payload.numbers = numbers;
            if (appIds.length) payload.appIds = appIds;
            const r = await apiFetch("/api/bulk/start", { method: "POST", headers, body: JSON.stringify(payload) });
            const ct = (r.headers.get("content-type") || "").toLowerCase();
            if (!r.ok) {
                const text = await r.text().catch(() => "");
                const first200 = (text || "").slice(0, 200);
                return { ok: false, message: first200 || `HTTP ${r.status}` };
            }
            if (!ct.includes("application/json")) {
                return { ok: false, message: `Non-JSON response from /api/bulk/start (status ${r.status})` };
            }
            const json = await r.json().catch(() => ({}));
            if (json && json.ok !== false) {
                const id = json.jobId || json.id || json.job?.id;
                if (id) return { ok: true, jobId: String(id) };
                return { ok: false, message: "Missing jobId in response" };
            }
            return { ok: false, message: json?.message || "Failed to start server job" };
        } catch (e: any) {
            return { ok: false, message: e?.message || "Network error starting server job" };
        }
    }

    // --- Processing ---
    // The original runProcessing is now renamed to runProcessingClient
    // Helper for sleeping
    function sleep(ms: number) {
        return new Promise<void>(resolve => setTimeout(resolve, ms));
    }
    async function runProcessingClient() {
        if (!rows.length) return;
        setProcessing(true);
        setStartedAt(Date.now());
        abortRef.current = false;

        // Progress is tracked via functional updates to avoid race conditions

        const queue = [...rows];
        const next = async () => {
            if (abortRef.current) return;
            const item = queue.shift();
            if (!item) return;

            updateRow(item.number, { status: "processing", message: "Checking local cache…" });

            let succeeded = false;
            try {
                const clsForSend = classifyAny(item.number);
                if (clsForSend.kind === "invalid" || !clsForSend.normalized) {
                    updateRow(item.number, { status: "error", message: "Invalid item format" });
                    // Progress update below in finally
                    if (queue.length) await next();
                    return;
                }
                const searchValue = clsForSend.normalized;
                let r: Response | undefined = undefined;
                if (clsForSend.kind === "application") {
                    // === FetchInfo-parity for Application ID ===
                    const appId = searchValue;
                    const token = localStorage.getItem("sla_token");

                    // 0) Local-only probe for application timeline (DB cache only)
                    const rLocal = await apiFetch("/api/search/application", {
                        method: "POST",
                        headers: {
                            "Accept": "application/json",
                            "Content-Type": "application/json",
                            ...(token ? { Authorization: `Bearer ${token}` } : {}),
                        },
                        body: JSON.stringify({ appId, strategy: "local-only" }),
                    });
                    let jLocal: any = null;
                    try { jLocal = await rLocal.json(); } catch { jLocal = null; }
                    if (rLocal.ok && jLocal && jLocal.ok !== false && Array.isArray(jLocal.statuses) && jLocal.statuses.length >= 0) {
                        // Cache hit, but we still run print→mobile→number(local-first) to ensure full app info (District/Block/Village) is persisted like FetchInfo
                        let cachedFlag = true; // from jLocal
                        try {
                            let mobile10: string | null = await fetchMobileViaPrint(appId);
                            if (mobile10 && /^\d{10}$/.test(mobile10)) {
                                const rNum = await apiFetch("/api/search/number", {
                                    method: "POST",
                                    headers: { "Accept": "application/json", "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                                    body: JSON.stringify({ number: mobile10, strategy: "local-first" }),
                                });
                                const jNum = await rNum.json().catch(() => ({}));
                                // If backend fetched/linked additional details, jNum.cached may be true/false; we keep message canonical
                                if (jNum && jNum.ok !== false) {
                                    if (jNum.cached === true) cachedFlag = true;
                                }
                            }
                        } catch { /* ignore enrichment errors; message remains 'Already available locally' */ }

                        const msg = cachedFlag ? "Already available locally" : "Fetched from government sources";
                        updateRow(item.number, { status: "ok", message: msg, response: { application: jLocal } });
                        succeeded = true;
                    } else {
                        // 1) Remote fetch (LOCAL-FIRST) by application id
                        if (MIN_GAP_MS > 0) {
                            const now = Date.now();
                            const elapsed = now - (lastLaunchRef.current || 0);
                            if (elapsed < MIN_GAP_MS) await sleep(MIN_GAP_MS - elapsed);
                            lastLaunchRef.current = Date.now();
                        }
                        const rApp = await apiFetch("/api/search/application", {
                            method: "POST",
                            headers: {
                                "Accept": "application/json",
                                "Content-Type": "application/json",
                                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                            },
                            body: JSON.stringify({ appId, strategy: "local-first" }),
                        });
                        const jApp = await rApp.json().catch(() => ({}));
                        if (!rApp.ok || (jApp && jApp.ok === false)) {
                            // Don’t bubble 500s: present a clean error
                            const errMsg = jApp?.message || `HTTP ${rApp.status}`;
                            updateRow(item.number, { status: "error", message: errMsg });
                            // Try a last-resort enrichment via tn-print → number (local-first) to salvage details
                            let mobile10: string | null = null;
                            try { mobile10 = await fetchMobileViaPrint(appId); } catch { mobile10 = null; }
                            if (mobile10 && /^\d{10}$/.test(mobile10)) {
                                const rNum = await apiFetch("/api/search/number", {
                                    method: "POST",
                                    headers: { "Accept": "application/json", "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                                    body: JSON.stringify({ number: mobile10, strategy: "local-first" }),
                                });
                                const jNum = await rNum.json().catch(() => ({}));
                                const apps = Array.isArray(jNum?.applications) ? jNum.applications : [];
                                if (apps.length) {
                                    const match = apps.find((a: any) => String(a?.application_id || a?.appId || a?.id || "").trim() === appId);
                                    const primaryApp = normalizeAppRow(match || apps[0] || null);
                                    // Remove detail concatenation from message
                                    const msg = (jNum?.cached === true ? "Already available locally" : "Fetched from government sources");
                                    updateRow(item.number, { status: "ok", message: msg, response: { number: jNum } });
                                }
                            }
                            // mark as not succeeded; progress counter will add an error
                        } else {
                            // Success: build message using returned statuses + detail (and enrich via print→number)
                            const statuses = Array.isArray(jApp?.statuses) ? jApp.statuses : [];
                            const latest = statuses.length ? statuses[0] : null;
                            // Try to get detail from mobile path
                            let detail = "";
                            let cachedFlag = false;
                            let mobile10: string | null = null;
                            try { mobile10 = await fetchMobileViaPrint(appId); } catch { mobile10 = null; }
                            if (mobile10 && /^\d{10}$/.test(mobile10)) {
                                const rNum = await apiFetch("/api/search/number", {
                                    method: "POST",
                                    headers: { "Accept": "application/json", "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                                    body: JSON.stringify({ number: mobile10, strategy: "local-first" }),
                                });
                                const jNum = await rNum.json().catch(() => ({}));
                                cachedFlag = jNum?.cached === true;
                                const apps = Array.isArray(jNum?.applications) ? jNum.applications : [];
                                const match = apps.find((a: any) => String(a?.application_id || a?.appId || a?.id || "").trim() === appId);
                                const primaryApp = normalizeAppRow(match || apps[0] || null);
                                detail = primaryApp ? appRowToInlineMessage(primaryApp) : "";
                            }
                            const msg = cachedFlag ? "Already available locally" : "Fetched from government sources";
                            updateRow(item.number, { status: "ok", message: msg, response: { application: jApp } });
                            succeeded = true;
                        }
                    }
                } else {
                    const token = localStorage.getItem("sla_token");
                    const normalized = (
  clsForSend.kind === "mobile" ? normalizeMobile10(searchValue) :
  clsForSend.kind === "aadhaar" ? normalizeAadhaar12(searchValue) :
  searchValue
);
                    // 0) Local-only probe: if found, do not call remote at all
                    try {
                        const probe = await apiFetch("/api/search/number", {
                            method: "POST",
                            headers: {
                                "Accept": "application/json",
                                "Content-Type": "application/json",
                                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                            },
                            body: JSON.stringify({ number: normalized, strategy: "local-only" }),
                        });
                        const pj = await probe.json().catch(() => ({}));
                        if (probe.ok && pj && pj.ok !== false) {
                            const apps = Array.isArray(pj.applications) ? pj.applications : [];
                            const statuses = Array.isArray(pj.statuses) ? pj.statuses : [];
                            const cached = pj.cached === true;
                            if (cached || apps.length > 0 || statuses.length > 0) {
                                updateRow(item.number, { status: "ok", message: "Already available locally", response: pj });
                                succeeded = true;
                                return; // Do NOT hit remote when local has the data
                            }
                        }
                    } catch { /* ignore and fall through to local-first */ }

                    // 1) Not found locally — proceed with local-first (backend may still serve from cache if filled during this run)
                    if (MIN_GAP_MS > 0) {
                        const now = Date.now();
                        const elapsed = now - (lastLaunchRef.current || 0);
                        if (elapsed < MIN_GAP_MS) {
                            await sleep(MIN_GAP_MS - elapsed);
                        }
                        lastLaunchRef.current = Date.now();
                    }
                    r = await apiFetch("/api/search/number", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            ...(token ? { Authorization: `Bearer ${token}` } : {}),
                        },
                        body: JSON.stringify({ number: normalized, strategy: "local-first" }),
                    });
                }

                if (r) {
                    const json = await r.json().catch(() => ({}));
                    if (r && r.ok && json && json.ok !== false) {
                        let msg = "";
                        const apps = Array.isArray(json.applications) ? json.applications : [];
                        const statuses = Array.isArray(json.statuses) ? json.statuses : [];
                        const cached = json.cached === true;
                        if (apps.length === 0 && statuses.length === 0) {
                            msg = "No applications found – Farmer hasn’t used the services";
                        } else if (cached) {
                            msg = "Already available locally";
                        } else {
                            msg = "Fetched from government sources";
                        }

                        // Detect any merge/link signals from backend to inform the user
                        const linkType = (json.linked?.type || json.linkAction || "").toString().toLowerCase();
                        const merged =
                            Boolean(json.merged) ||
                            Boolean(json.linked) ||
                            linkType === "aadhaar" ||
                            linkType === "mobile" ||
                            (typeof json.linked?.action === "string" && json.linked.action.toLowerCase() === "link") ||
                            (typeof json.action === "string" && json.action.toLowerCase() === "link");

                        if (merged) {
                            msg += " • Merged with existing data";
                            // (Optional: keep the specific detail)
                            if (linkType === "aadhaar") msg += " (Aadhaar)";
                            if (linkType === "mobile") msg += " (Mobile)";
                        }
                        // Simplify: do not append detail, only base message
                        updateRow(item.number, { status: "ok", message: msg, response: json });
                        // Do not enrich message after OK (no inline detail)
                        succeeded = true;
                    } else {
                        let msg = json?.message || "";
                        if (!msg) {
                            try { msg = await r.text(); } catch { /* ignore */ }
                        }
                        updateRow(item.number, { status: "error", message: msg || `HTTP ${r.status}` });
                    }
                }
            } catch (e: any) {
                updateRow(item.number, { status: "error", message: e?.message || "Network error" });
            } finally {
                // Always increment done; adjust ok/error based on success flag using functional updates
                setProgress((p) => ({
                    ...p,
                    done: Math.min(p.done + 1, p.total),
                    ok: p.ok + (succeeded ? 1 : 0),
                    error: p.error + (succeeded ? 0 : 1),
                }));
                if (queue.length) await next();
            }
        };

        // kick off N workers
        await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, rows.length) }, () => next()));

        setProcessing(false);
    }

    // New wrapper for processing, chooses server or client (always tries to start a server job first)
    async function runProcessing() {
        if (processing) return;
        if (!rows.length) return;

        // Always prefer server job so Jobs are created even when data is already local
        if (serverMode) {
            setProcessing(true);
            setStartedAt(Date.now());
            setProgress({ total: rows.length, done: 0, ok: 0, error: 0 });
            try {
                const resAll = await startServerJobAll(rows);
                if (resAll.ok && resAll.jobId) {
                    setJobId(resAll.jobId);
                    localStorage.setItem(LS_JOB_KEY, resAll.jobId);
                    const seeded = rows.map(r => (r.status === 'ok' ? r : { ...r, status: "processing", message: "Queued on server…" }));
                    setRows(seeded);
                    saveSnapshot(resAll.jobId, { total: rows.length, done: 0, ok: 0, error: 0 }, seeded);
                    setRecentJobs(await fetchRecentServerJobs(30));
                    return; // polling effect will take over
                }
                // Fall back to previous split starters for compatibility (numbers then appIds)
                let started = false;
                const numberRows = rows.filter(r => r.kind === "mobile" || r.kind === "aadhaar");
                const appIdRows = rows.filter(r => r.kind === "application");
                if (numberRows.length) {
                    const resNum = await tryStartServerJobForNumbers(numberRows);
                    if (resNum.ok && resNum.jobId) {
                        setJobId(resNum.jobId);
                        localStorage.setItem(LS_JOB_KEY, resNum.jobId);
                        const seeded = rows.map(r => (r.status === 'ok' ? r : { ...r, status: "processing", message: "Queued on server…" }));
                        setRows(seeded);
                        saveSnapshot(resNum.jobId, { total: rows.length, done: 0, ok: 0, error: 0 }, seeded);
                        setRecentJobs(await fetchRecentServerJobs(30));
                        started = true;
                    }
                }
                if (!started && appIdRows.length) {
                    const resApp = await tryStartServerJobForApplications(appIdRows.map(r => r.number));
                    if (resApp.ok && resApp.jobId) {
                        setJobId(resApp.jobId);
                        localStorage.setItem(LS_JOB_KEY, resApp.jobId);
                        const seeded = rows.map(r => (r.status === 'ok' ? r : { ...r, status: "processing", message: "Queued on server…" }));
                        setRows(seeded);
                        saveSnapshot(resApp.jobId, { total: rows.length, done: 0, ok: 0, error: 0 }, seeded);
                        setRecentJobs(await fetchRecentServerJobs(30));
                        started = true;
                    }
                }
                if (started) return; // polling will handle updates
            } catch (e) {
                // ignore and fall through to client mode
            }
            // If we couldn't start any server job, fall back to client processing
            setProcessing(false);
        }
        await runProcessingClient();
    }

    function updateRow(num: string, patch: Partial<ResultRow> | ((curr?: ResultRow) => Partial<ResultRow>)) {
        setRows((prev) =>
            prev.map((r) => {
                if (r.number !== num) return r;
                const add = typeof patch === "function" ? (patch as any)(r) : patch;
                return { ...r, ...add };
            })
        );
    }

    async function cancel() {
        // If a server-side job is running, cancel it at the backend (but do NOT delete records)
        if (jobId) {
            const yes = window.confirm("Stop this server job now? (Records already saved will remain.)");
            if (!yes) return;

            // Cancel-only: do not delete any records. Hit the cancel endpoint directly.
            try {
                const token = localStorage.getItem("sla_token");
                const r = await apiFetch(`/api/bulk/${jobId}/cancel`, {
                    method: "POST",
                    headers: {
                        "Accept": "application/json",
                        "Content-Type": "application/json",
                        ...(token ? { Authorization: `Bearer ${token}` } : {}),
                    },
                });
                if (!r.ok) {
                    let msg = "Failed to cancel server job.";
                    try { const j = await r.json(); if (j?.message) msg = j.message; } catch {}
                    setParseError(msg);
                    return;
                }
            } catch (e: any) {
                setParseError(e?.message || "Failed to cancel server job.");
                return;
            }

            // Mark last action, clear persisted job pointers, stop viewing
lastServerActionRef.current = 'cancel';
try { localStorage.removeItem(LS_JOB_KEY); } catch { }
try { localStorage.removeItem(LS_PROGRESS_KEY); } catch { }

setProcessing(false);

// Reset state and hide view
resetAll();
handleHideView();

// Reset file input so re-upload works immediately
if (fileInputRef.current) {
  try { fileInputRef.current.value = ""; } catch {}
}
setFileInputKey((k) => k + 1);

// Refresh recent jobs silently
setRecentJobs(await fetchRecentServerJobs(2, { silent: true }));
return;
        }
        // Otherwise, this is a purely local run — just abort the client workers
        abortRef.current = true;
        setProcessing(false);
    }

    // Dedicated handler to delete all records for a job (robust multi-endpoint)
    async function deleteRecords() {
        if (!jobId) return;
        const yes = window.confirm("Delete all records for this job from the server? This cannot be undone.");
        if (!yes) return;

        const token = localStorage.getItem("sla_token");
        const headers: any = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
        };

        // Try common variants: DELETE /api/bulk/:id → POST /api/bulk/:id/delete → POST /api/bulk/delete { jobId }
        const attempts: Array<{ method: string; path: string; body?: any }> = [
            { method: "DELETE", path: `/api/bulk/${jobId}` },
            { method: "POST", path: `/api/bulk/${jobId}/delete` },
            { method: "POST", path: "/api/bulk/delete", body: { jobId } },
        ];

        let success = false;
        let lastErrMsg = "";
        for (const a of attempts) {
            try {
                const init: RequestInit = { method: a.method, headers };
                if (a.body) init.body = JSON.stringify(a.body);
                const r = await apiFetch(a.path, init);
                if (r.ok) { success = true; break; }
                try { const j = await r.json(); if (j?.message) lastErrMsg = j.message; }
                catch { lastErrMsg = `HTTP ${r.status}`; }
            } catch (e: any) {
                lastErrMsg = e?.message || String(e);
            }
        }

        if (!success) {
            setParseError(lastErrMsg || "Failed to delete job records.");
            return;
        }

        // Mark action and update UI immediately
        lastServerActionRef.current = 'delete';
        try { localStorage.removeItem(LS_JOB_KEY); } catch {}
        try { localStorage.removeItem(LS_PROGRESS_KEY); } catch {}

        // Clear local view state and simply hide the banner; let backend control list visibility
        setFile(null);
        setNumbers([]);
        resetAll();
        handleHideView();

        // Refresh list from backend (no loading banner)
        setRecentJobs(await fetchRecentServerJobs(30, { silent: true }));
    }

    // --- downloads ---
    function downloadTemplate() {
        // Add header in Row 1, Column 1 as "Numbers"
        const example = [
            ["Numbers"],
            ["9894064306"],
            ["8610263923"],
            ["514406278810"], // Aadhaar example
        ];
        dynamicDownloadXlsx(example, "bulk-template.xlsx", "Sheet1");
    }


    async function dynamicDownloadXlsx(aoa: any[][], filename: string, sheetName: string) {
        // Ensure every value is a string so Excel treats everything as text.
        const stringified = (aoa || []).map((row) => row.map((v) => (v == null ? "" : String(v))));
        const ws = XLSX.utils.aoa_to_sheet(stringified, { raw: false });

        // Force every cell type to 's' (string) and number format to text ('@')
        Object.keys(ws).forEach((addr) => {
            if (addr.startsWith("!")) return;
            const cell: any = ws[addr];
            if (!cell) return;
            cell.t = "s";
            cell.z = "@";
        });

        // Optional: set a comfortable width for the first column
        ws["!cols"] = [{ wch: 24 }];

        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, sheetName || "Sheet1");
        XLSX.writeFile(wb, filename);
    }

    // --- UI helpers ---
    const completedCount = useMemo(
        () => Math.min(progress.ok + progress.error, progress.total),
        [progress.ok, progress.error, progress.total]
    );
    const pct = progress.total ? Math.round((completedCount / progress.total) * 100) : 0;
    const eta = useMemo(() => {
        if (!startedAt || completedCount === 0) return null;
        const elapsed = Date.now() - startedAt; // ms
        const perItem = elapsed / completedCount;
        const remaining = (progress.total - completedCount) * perItem;
        return msToNice(remaining);
    }, [startedAt, completedCount, progress.total]);

    function msToNice(ms: number) {
        const s = Math.round(ms / 1000);
        if (s < 60) return `${s}s`;
        const m = Math.floor(s / 60);
        const rs = s % 60;
        return `${m}m ${rs}s`;
    }

    // --- drag & drop ---
    const dzRef = useRef<HTMLLabelElement | null>(null);
    useEffect(() => {
        const el = dzRef.current;
        if (!el) return;
        // Ensure a hidden <input type="file"> exists and connect it to the dropzone click
        const ensureHiddenInput = () => {
            if (fileInputRef.current && document.body.contains(fileInputRef.current)) return fileInputRef.current;
            const inp = document.createElement('input');
            inp.type = 'file';
            inp.accept = '.xlsx,.xls,.csv';
            inp.style.position = 'fixed';
            inp.style.left = '-9999px';
            inp.style.width = '1px';
            inp.style.height = '1px';
            inp.style.opacity = '0';
            inp.addEventListener('change', (ev: Event) => {
                const t = ev.target as HTMLInputElement;
                const f = t?.files?.[0] || null;
                if (f) onFilePicked(f);
            });
            document.body.appendChild(inp);
            fileInputRef.current = inp;
            return inp;
        };

        const onClick = (e: MouseEvent) => {
            e.preventDefault();
            e.stopPropagation();
            const inp = ensureHiddenInput();
            try { if (inp) (inp as HTMLInputElement).value = ''; } catch {}
            (inp as HTMLInputElement)?.click();
        };

        el.addEventListener('click', onClick as any);
        const onDrag = (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            el.classList.add("ring-2", "ring-blue-500/40");
        };
        const onLeave = (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            el.classList.remove("ring-2", "ring-blue-500/40");
        };
        const onDrop = (e: DragEvent) => {
            e.preventDefault();
            e.stopPropagation();
            el.classList.remove("ring-2", "ring-blue-500/40");
            const f = e.dataTransfer?.files?.[0];
            if (f) onFilePicked(f);
        };
        el.addEventListener("dragover", onDrag);
        el.addEventListener("dragenter", onDrag);
        el.addEventListener("dragleave", onLeave);
        el.addEventListener("drop", onDrop);
        return () => {
            el.removeEventListener("dragover", onDrag);
            el.removeEventListener("dragenter", onDrag);
            el.removeEventListener("dragleave", onLeave);
            el.removeEventListener("drop", onDrop);
            el.removeEventListener("click", onClick as any);
        };
    }, []);

    // Try to discover the latest server job for this user
    async function fetchLatestServerJobId(): Promise<string | null> {
        try {
            const token = localStorage.getItem("sla_token");
            const r = await apiFetch("/api/bulk/latest", {
                headers: { "Accept": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }
            });
            if (!r.ok) return null;
            if (r.status === 401 || r.status >= 500) return null;
            const ct = (r.headers.get("content-type") || "").toLowerCase();
            if (!ct.includes("application/json")) return null;
            const json = await r.json();
            const id = json?.job?.id || json?.jobId || json?.id || null;
            return id ? String(id) : null;
        } catch { return null; }
    }

    // On mount / when no file selected, try to auto-resume from server
    useEffect(() => {
        if (file) return; // working locally — don't auto-resume a server job
        (async () => {
            if (isAutoViewSuppressed()) return; // avoid immediate re-open after Hide
            const last = localStorage.getItem(LS_JOB_KEY);
            if (last) {
                setJobId(last);
                setProcessing(true);
                tryRestoreSnapshot(last);
                if (!createdBy) {
                    const n = getCreatedBy();
                    if (n) setCreatedBy(n);
                }
            }
            const latest = await fetchLatestServerJobId();
            if (latest && latest !== last) {
                setJobId(latest);
                setProcessing(true);
                tryRestoreSnapshot(latest);
                localStorage.setItem(LS_JOB_KEY, latest);
                if (!createdBy) {
                    const n = getCreatedBy();
                    if (n) setCreatedBy(n);
                }
            }
        })();
    }, [file]);

    // --- Server job polling ---
    // Map backend job-item state to our UI ItemStatus, robustly normalizing synonyms and considering state_text.
    function mapStateToStatus(it: any): ItemStatus {
        const raw = String((it?.status ?? it?.state ?? it?.state_text ?? "")).toLowerCase().trim();
        // Normalize a few common synonyms
        if (["ok", "success", "completed", "done", "complete"].includes(raw)) return "ok";
        if (["error", "failed", "fail", "failure"].includes(raw)) return "error";
        if (["processing", "running", "pending", "queued", "queue", "in_progress"].includes(raw)) return "processing";
        // Default to processing while backend works
        return "processing";
    }

    // Extracted pollOnce for one-off status polling
    async function pollOnce() {
        if (!jobId) return;
        try {
            const token = localStorage.getItem("sla_token");
            const r = await apiFetch(`/api/bulk/${jobId}/status`, {
                headers: {
                    "Accept": "application/json",
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                }
            });
            const ct = (r.headers.get("content-type") || "").toLowerCase();
            let json: any = null;
            if (ct.includes("application/json")) {
                json = await r.json();
              } else {
                // Transient network/proxy hiccup; do not show a parse error during processing
                try { await r.text(); } catch {}
                console.warn(`[pollOnce] Non-JSON status response (${r.status}); will retry on next tick.`);
                return; // keep polling
              }
            if (r.ok && json?.ok) {
                const job = json.job || {};
                const fromServerCreator = String(job.created_by || job.createdBy || "").trim();
                if (fromServerCreator && fromServerCreator !== createdBy) {
                    setCreatedBy(fromServerCreator);
                }
                const items = Array.isArray(json.items) ? json.items : [];

                // Update top-level counters if present; otherwise derive them
                const total = Number(job.total ?? items.length ?? 0) || 0;
                let done = Number(job.done ?? 0) || 0;
                let ok = Number(job.ok ?? 0) || 0;
                let error = Number(job.error ?? 0) || 0;
                if (job.done == null) {
                    const counts = items.reduce((acc: any, it: any) => {
                        const s = mapStateToStatus(it);
                        if (s === "ok" || s === "error") acc.done++;
                        if (s === "ok") acc.ok++;
                        if (s === "error") acc.error++;
                        return acc;
                    }, { done: 0, ok: 0, error: 0 });
                    done = counts.done; ok = counts.ok; error = counts.error;
                }
                const newProg = { total, done, ok, error };

                // Map items to our UI rows with simplified message logic
                const mapped: ResultRow[] = items.map((it: any) => {
                    const num = String(it.number ?? it.input ?? "");
                    const backendKind = (it.kind || "").toString().toLowerCase();
                    const inferred = inferKindFromDigits(num);
                    const kind: "mobile" | "aadhaar" | "application" | "unknown" =
                        backendKind === "mobile" || backendKind === "aadhaar" || backendKind === "application"
                            ? (backendKind as any)
                            : inferred;
                    const st = mapStateToStatus(it);
                    let msg = it.message || it.last_message || it.detail || "";
                    if (!msg) {
                        if (st === "ok") msg = "Completed";
                        else if (st === "error") msg = "Failed";
                        else if (st === "processing") msg = "Processing on server…";
                    }
                    // Only use base message, do not append inline detail
                    return { number: num, kind, status: st, message: msg };
                });

                let rowsToSet: ResultRow[];
                if (items.length > 0) {
                    rowsToSet = mapped.slice().reverse();
                } else {
                    const statusText = String(job.status || "queued").toLowerCase();
                    const msg = statusText === "running" ? "Processing on server…" : statusText === "queued" ? "Queued on server…" : `Job ${statusText}`;
                    rowsToSet = (rows && rows.length > 0)
                        ? rows.map(r => ({ ...r, status: "processing", message: msg }))
                        : [{
                            number: String(job.id || jobId || "job"),
                            kind: "unknown",
                            status: mapStateToStatus({ status: job.status, error: (Number(error) || 0) > 0 }),
                            message: `Job ${statusText} • OK: ${ok} • Err: ${error}`.trim()
                        }];
                }
                setProgress(newProg);
                setRows(rowsToSet);
                // Remove enrichment loops that add inline detail
                saveSnapshot(jobId, newProg, rowsToSet);

                const jStatus = String(job.status || "").toLowerCase();
                if (["done", "completed", "canceled", "error", "failed"].includes(jStatus)) {
                    // Stop showing it as running, but keep the job in view so the user can click Hide.
                    setProcessing(false);
                    // Do NOT clear LS keys or jobId here.
                    // Just refresh the recent list so counters update.
                    setRecentJobs(await fetchRecentServerJobs(30));
                }
            } else {
                if (r.status === 404) {
                    // If we just canceled/deleted, a 404 is expected; suppress error and stop viewing.
                    if (lastServerActionRef.current === 'cancel' || lastServerActionRef.current === 'delete') {
                        setRows([]);
                        setProcessing(false);
                        lastServerActionRef.current = null; // clear the flag
                        return;
                    }
                    // Otherwise, surface a soft message and stop viewing
                    setParseError('Job not found on server (404). It may have expired.');
                    setRows([]);
                    setProcessing(false);
                    return;
                }
            }
        } catch (e: any) {
            // Transient network error while polling; do not break UI or show red banner
            console.warn("[pollOnce] network error:", e?.message || e);
            return; // next interval will retry
          }
    }

    useEffect(() => {
        let t: any;
        if (jobId) {
            setProcessing(true);
            pollOnce();
            t = setInterval(pollOnce, 2000);
        }
        return () => { if (t) clearInterval(t); }
    }, [jobId]);

    // --- Server Jobs (recent) additions ---
    type RecentJob = { id: string; status?: string; created_at?: string; created_by?: string; total?: number; done?: number; ok?: number; error?: number; };

    // --- Job status helpers ---
    const RUNNING_STATES = new Set(["running", "processing", "pending", "queued", "in_progress"]);
    const TERMINAL_STATES = new Set(["done", "completed", "complete", "canceled", "cancelled", "error", "failed"]);
    const PAUSED_STATES = new Set(["paused", "pause", "stopped"]);

    function isRunningStatus(s?: string | null): boolean {
      if (!s) return false;
      return RUNNING_STATES.has(String(s).toLowerCase());
    }
    function isTerminalStatus(s?: string | null): boolean {
      if (!s) return false;
      return TERMINAL_STATES.has(String(s).toLowerCase());
    }
    function isPausedStatus(s?: string | null): boolean {
      if (!s) return false;
      return PAUSED_STATES.has(String(s).toLowerCase());
    }

    const [recentJobs, setRecentJobs] = useState<RecentJob[]>([]);
    const [recentError, setRecentError] = useState<string | null>(null);

    function formatIST(iso?: string) {
        if (!iso) return "";
        try {
            const d = new Date(iso);
            return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
        } catch { return iso; }
    }

    async function fetchRecentServerJobs(days = 2, opts?: { silent?: boolean }): Promise<RecentJob[]> {
        const silent = Boolean(opts?.silent);
        if (!silent) setRecentError(null);
        try {
            const token = localStorage.getItem("sla_token");
            // Preferred endpoint
            let r = await apiFetch(`/api/bulk/recent?days=${days}`, {
                headers: { "Accept": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }
            });
            if (!r.ok) {
                if (r.status === 401 || r.status >= 500) return [];
            }
            if (r.ok && (r.headers.get("content-type") || "").toLowerCase().includes("application/json")) {
                const json = await r.json();
                const list: any[] = Array.isArray(json?.jobs) ? json.jobs : Array.isArray(json) ? json : [];
                const mapped: RecentJob[] = list.map(it => ({
                    id: String(it.id ?? it.job_id ?? it.jobId ?? ""),
                    status: it.status ?? "",
                    created_at: it.created_at ?? it.started_at ?? it.createdAt ?? it.created ?? "",
                    created_by: it.created_by ?? it.createdBy ?? "",
                    total: Number(it.total ?? 0) || 0,
                    done: Number(it.done ?? 0) || 0,
                    ok: Number(it.ok ?? 0) || 0,
                    error: Number(it.error ?? 0) || 0,
                })).filter(j => j.id);
                return mapped;
            }
            // Fallback to single latest if /recent unavailable
            const latest = await fetchLatestServerJobId();
            if (latest) {
                return [{ id: latest }];
            }
            return [];
        } catch (e: any) {
            if (!silent) setRecentError(e?.message || "Failed to load recent jobs.");
            return [];
        } finally {
        }
    }

    async function handleReloadRecent() {
        try {
            const list = await fetchRecentServerJobs(2, { silent: true });
            setRecentJobs(list);
            setRecentError(null);
        } catch {
            // On any reload error, just show empty state instead of an error banner
            setRecentJobs([]);
            setRecentError(null);
        }
    }

    useEffect(() => {
        (async () => {
            const list = await fetchRecentServerJobs(30);
            setRecentJobs(list);
        })();
    }, []);

    // Wake-up hook: when user returns to the tab or network comes back, force-refresh lists and one-shot poll
    useEffect(() => {
        const onWake = () => {
            // Refresh recent jobs
            handleReloadRecent();
            // If a job is open, poll it once immediately
            if (jobId) {
                pollOnce();
            }
        };
        const onVisibility = () => {
            if (document.visibilityState === 'visible') onWake();
        };

        window.addEventListener('focus', onWake);
        window.addEventListener('online', onWake);
        window.addEventListener('pageshow', onWake);
        document.addEventListener('visibilitychange', onVisibility);

        return () => {
            window.removeEventListener('focus', onWake);
            window.removeEventListener('online', onWake);
            window.removeEventListener('pageshow', onWake);
            document.removeEventListener('visibilitychange', onVisibility);
        };
    }, [jobId]);


    // Poll a job status by a specific id (does not mutate jobId)
    async function pollOnceById(id: string) {
        if (!id) return;
        try {
            const token = localStorage.getItem("sla_token");
            const r = await apiFetch(`/api/bulk/${id}/status`, {
                headers: {
                    "Accept": "application/json",
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                }
            });
            const ct = (r.headers.get("content-type") || "").toLowerCase();
            let json: any = null;
            if (ct.includes("application/json")) {
                json = await r.json();
              } else {
                try { await r.text(); } catch {}
                console.warn(`[pollOnceById] Non-JSON status response (${r.status}); will retry on next trigger.`);
                return; // do not show red error during active jobs
              }
            if (r.ok && json?.ok) {
                const job = json.job || {};
                const fromServerCreator = String(job.created_by || job.createdBy || "").trim();
                if (fromServerCreator && fromServerCreator !== createdBy) {
                    setCreatedBy(fromServerCreator);
                }
                const items = Array.isArray(json.items) ? json.items : [];

                // Update top-level counters if present; otherwise derive them
                const total = Number(job.total ?? items.length ?? 0) || 0;
                let done = Number(job.done ?? 0) || 0;
                let ok = Number(job.ok ?? 0) || 0;
                let error = Number(job.error ?? 0) || 0;

                if (job.done == null) {
                    // derive from items if counters not provided
                    const counts = items.reduce((acc: any, it: any) => {
                        const s = mapStateToStatus(it);
                        if (s === "ok") acc.ok++;
                        else if (s === "error") acc.error++;
                        else if (s === "pending") acc.pending++;
                        else if (s === "processing") acc.processing++;
                        return acc;
                    }, { ok: 0, error: 0, pending: 0, processing: 0 });
                    ok = counts.ok;
                    error = counts.error;
                    done = ok + error;
                }

                setProgress(prev => {
                    const newTotal = Math.max(prev.total, Number(total) || 0);
                    const newDone = Math.max(prev.done, Number(done) || 0);
                    const newOk = Math.max(prev.ok, Number(ok) || 0);
                    const newErr = Math.max(prev.error, Number(error) || 0);
                    return { total: newTotal, done: newDone, ok: newOk, error: newErr };
                });

                // Map items to our UI rows with simplified message logic
                const mapped: ResultRow[] = items.map((it: any) => {
                    const num = String(it.number ?? it.input ?? "");
                    const backendKind = (it.kind || "").toString().toLowerCase();
                    const inferred = inferKindFromDigits(num);
                    const kind: "mobile" | "aadhaar" | "application" | "unknown" =
                        backendKind === "mobile" || backendKind === "aadhaar" || backendKind === "application"
                            ? (backendKind as any)
                            : inferred;
                    const st = mapStateToStatus(it);
                    let msg = it.message || it.last_message || it.detail || "";
                    if (!msg) {
                        if (st === "ok") msg = "Completed";
                        else if (st === "error") msg = "Failed";
                        else if (st === "processing") msg = "Processing on server…";
                    }
                    // Only use base message, do not append inline detail
                    return {
                        number: num,
                        kind,
                        status: st,
                        message: msg
                    };
                });


                if (items.length > 0) {
                    setRows(mapped.slice().reverse());
                } else {
                    const statusText = String(job.status || "queued").toLowerCase();
                    const msg = statusText === "running" ? "Processing on server…" : statusText === "queued" ? "Queued on server…" : `Job ${statusText}`;
                    if (rows && rows.length > 0) {
                        setRows(rows.map(r => ({ ...r, status: "processing", message: msg })));
                    } else {
                        const synthetic: ResultRow = {
                            number: String(job.id || (typeof id !== "undefined" ? id : jobId) || "job"),
                            kind: "unknown",
                            status: mapStateToStatus({ status: job.status, error: (Number(error) || 0) > 0 }),
                            message: `Job ${statusText} • OK: ${ok} • Err: ${error}`.trim()
                        };
                        setRows([synthetic]);
                    }
                }

                const jStatus = String(job.status || "").toLowerCase();
                if (["done", "completed", "canceled", "error", "failed"].includes(jStatus)) {
                    // Stop showing it as running, but keep the job in view so the user can click Hide.
                    setProcessing(false);
                    // Do NOT clear jobId or localStorage here.
                    setRecentJobs(await fetchRecentServerJobs(30, { silent: true }));
                }
            } else {
                // Treat missing/404 as terminal unless transient
                if (r.status === 404) {
                    if (lastServerActionRef.current === 'cancel' || lastServerActionRef.current === 'delete') {
                        // Expected right after we canceled/deleted the job
                        setRows([]);
                        setProcessing(false);
                        lastServerActionRef.current = null;
                        return;
                    }
                    setParseError('Job not found on server (404). It may have expired.');
                    setProcessing(false);
                }
            }
        } catch (e: any) {
            console.warn("[pollOnceById] network error:", e?.message || e);
            return;
          }
    }

    function handleHideView() {
        // Exit view without canceling/deleting; prevent immediate auto-resume for a short window
        setJobId(null);
        setProcessing(false);
        setSuppressAutoView(15); // minutes

        // Also clear the on-screen rows/progress so the view truly collapses
        setRows([]);
        setProgress({ total: 0, done: 0, ok: 0, error: 0 });
    }

    function isViewing(id: string) {
        return jobId === id;
    }

    function handleLoadRecent(id: string) {
        if (!id) return;
        clearSuppressAutoView(); // manual View overrides suppression
        setJobId(id);
        lastServerActionRef.current = null;
        setProcessing(true);
        setProgress({ total: 0, done: 0, ok: 0, error: 0 });
        localStorage.setItem(LS_JOB_KEY, id);
        tryRestoreSnapshot(id);
        pollOnceById(id);
    }

    // Cancel a server job (try multiple backend variants)
    async function cancelServerJob(id: string): Promise<{ ok: boolean; message?: string }> {
        if (!id) return { ok: false, message: "Missing job id" };
        const token = localStorage.getItem("sla_token");
        const headers: any = { "Accept": "application/json", "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
        const attempts: Array<{ method?: string; path: string; body?: any }> = [
            { method: "POST", path: `/api/bulk/${id}/cancel` },
            { method: "POST", path: "/api/bulk/cancel", body: { id } },
            { method: "PATCH", path: `/api/bulk/${id}`, body: { status: "canceled" } },
        ];
        for (const a of attempts) {
            try {
                const r = await apiFetch(a.path, { method: a.method || "POST", headers, body: a.body ? JSON.stringify(a.body) : undefined });
                if (!r.ok) continue;
                const ct = (r.headers.get("content-type") || "").toLowerCase();
                if (ct.includes("application/json")) {
                    const j = await r.json();
                    if (j && j.ok !== false) return { ok: true };
                } else {
                    return { ok: true };
                }
            } catch { }
        }
        return { ok: false, message: "Cancel request failed on all variants" };
    }

    // Pause a running server job (non-destructive)
    async function pauseServerJob(id: string): Promise<{ ok: boolean; message?: string }> {
        if (!id) return { ok: false, message: "Missing job id" };
        const token = localStorage.getItem("sla_token");
        const headers: any = { "Accept": "application/json", "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
        const attempts: Array<{ method?: string; path: string; body?: any }> = [
            { method: "POST", path: `/api/bulk/${id}/pause` },
            { method: "POST", path: "/api/bulk/pause", body: { id } },
            { method: "PATCH", path: `/api/bulk/${id}`, body: { status: "paused" } },
        ];
        for (const a of attempts) {
            try {
                const r = await apiFetch(a.path, { method: a.method || "POST", headers, body: a.body ? JSON.stringify(a.body) : undefined });
                if (!r.ok) continue;
                const ct = (r.headers.get("content-type") || "").toLowerCase();
                if (ct.includes("application/json")) {
                    const j = await r.json();
                    if (j && j.ok !== false) return { ok: true };
                } else {
                    return { ok: true };
                }
            } catch { }
        }
        return { ok: false, message: "Pause request failed on all variants" };
    }

    // Resume a paused server job (try multiple backend variants)
    async function resumeServerJob(id: string): Promise<{ ok: boolean; message?: string }> {
        if (!id) return { ok: false, message: "Missing job id" };
        const token = localStorage.getItem("sla_token");
        const headers: any = { "Accept": "application/json", "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
        const attempts: Array<{ method?: string; path: string; body?: any }> = [
            { method: "POST", path: `/api/bulk/${id}/resume` },
            { method: "POST", path: "/api/bulk/resume", body: { id } },
            { method: "PATCH", path: `/api/bulk/${id}`, body: { status: "running" } },
        ];
        for (const a of attempts) {
            try {
                const r = await apiFetch(a.path, { method: a.method || "POST", headers, body: a.body ? JSON.stringify(a.body) : undefined });
                if (!r.ok) continue;
                const ct = (r.headers.get("content-type") || "").toLowerCase();
                if (ct.includes("application/json")) {
                    const j = await r.json();
                    if (j && j.ok !== false) return { ok: true };
                } else {
                    return { ok: true };
                }
            } catch { }
        }
        return { ok: false, message: "Resume request failed on all variants" };
    }

    // Delete a server job; if purge=true, ask backend to delete all records created by the job
    async function deleteServerJob(id: string, purge = true): Promise<{ ok: boolean; message?: string }> {
        if (!id) return { ok: false, message: "Missing job id" };
        const token = localStorage.getItem("sla_token");
        const headers: any = { "Accept": "application/json", "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
        const qs = purge ? "?purge=1" : "";
        const attempts: Array<{ method?: string; path: string; body?: any }> = [
            { method: "DELETE", path: `/api/bulk/${id}${qs}` },
            { method: "POST", path: `/api/bulk/${id}/delete${qs}` },
            { method: "POST", path: "/api/bulk/delete", body: { id, purge } },
        ];
        for (const a of attempts) {
            try {
                const r = await apiFetch(a.path, { method: a.method || "POST", headers, body: a.body ? JSON.stringify(a.body) : undefined });
                if (!r.ok) continue;
                const ct = (r.headers.get("content-type") || "").toLowerCase();
                if (ct.includes("application/json")) {
                    const j = await r.json();
                    if (j && j.ok !== false) return { ok: true };
                } else {
                    return { ok: true };
                }
            } catch { }
        }
        return { ok: false, message: "Delete request failed on all variants" };
    }

    // UI handlers for cancel/delete with confirmation and local state updates
    async function handleCancelJobClick(id: string) {
        if (!id) return;
        const yes = window.confirm("Cancel this job? Running tasks will be stopped.");
        if (!yes) return;
        const res = await cancelServerJob(id);
        if (!res.ok) {
            setParseError(res.message || "Failed to cancel job.");
            return;
        }
        // Mark last action, clear persisted job pointers, and stop viewing immediately
        lastServerActionRef.current = 'cancel';
        try { localStorage.removeItem(LS_JOB_KEY); } catch { }
        try { localStorage.removeItem(LS_PROGRESS_KEY); } catch { }
        // Clear ALL Excel parsing fields/state
        setFile(null);
        setNumbers([]);
        resetAll();
        handleHideView();
        // Refresh the recent jobs list
        setRecentJobs(await fetchRecentServerJobs(2));
    }

    // Pause-click handler
    async function handlePauseJobClick(id: string) {
        if (!id) return;
        const yes = window.confirm("Pause this job? You can resume later.");
        if (!yes) return;
        const res = await pauseServerJob(id);
        if (!res.ok) {
            setParseError(res.message || "Failed to pause job.");
            return;
        }
        // Keep job selection; just mark UI not processing and refresh
        setProcessing(false);
        await pollOnceById(id);
        setRecentJobs(await fetchRecentServerJobs(2, { silent: true }));
    }

    async function handleResumeJobClick(id: string) {
        if (!id) return;
        const res = await resumeServerJob(id);
        if (!res.ok) {
            setParseError(res.message || "Failed to resume job.");
            return;
        }
        clearSuppressAutoView();
        setJobId(id);
        setProcessing(true);
        localStorage.setItem(LS_JOB_KEY, id);
        tryRestoreSnapshot(id);
        await pollOnceById(id);
        setRecentJobs(await fetchRecentServerJobs(2, { silent: true }));
    }

    async function handleDeleteJobClick(id: string) {
        if (!id) return;
        const purge = window.confirm("Delete this job AND all records it created?\nThis is irreversible.");
        if (!purge) return;
        const res = await deleteServerJob(id, true);
        if (!res.ok) {
            setParseError(res.message || "Failed to delete job.");
            return;
        }
        // Mark last action, clear persisted job pointers
        lastServerActionRef.current = 'delete';
        try { localStorage.removeItem(LS_JOB_KEY); } catch { }
        try { localStorage.removeItem(LS_PROGRESS_KEY); } catch { }

        // If the deleted job is currently selected, hide it and clear progress/rows
        if (jobId === id) {
            handleHideView();
        }
        // Reload recent jobs list
        setRecentJobs(await fetchRecentServerJobs(2));
    }


    return (
        <div className="max-w-6xl mx-auto p-6 space-y-6">
            <div className="flex items-center justify-between">
                <h1 className="text-2xl font-extrabold tracking-tight">Bulk Processing</h1>
                <div className="flex gap-2">
                    <button
                        onClick={downloadTemplate}
                        className="rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-100 dark:hover:bg-slate-800"
                    >
                        Download Template
                    </button>
                </div>
            </div>


            {/* Server Jobs (last 2 days) */}
            <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5">
                <div className="flex items-center justify-between mb-3">
                    <div className="text-sm font-semibold">Server Jobs (last 2 days)</div>
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={handleReloadRecent}
                            className="inline-flex items-center rounded-md border px-3 py-1 text-sm hover:bg-gray-50"
                        >
                            Reload list
                        </button>
                    </div>
                </div>
                {recentError && (
                    <div className="mb-3 rounded-lg border border-rose-300 bg-rose-50 text-rose-800 px-3 py-2 text-sm">
                        {recentError}
                    </div>
                )}
                <div className="overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
                    <table className="min-w-full text-sm">
                        <thead className="bg-slate-100 dark:bg-slate-800">
                            <tr>
                                <th className="px-3 py-2 text-left font-semibold">Job ID</th>
                                <th className="px-3 py-2 text-left font-semibold">Created (IST)</th>
                                <th className="px-3 py-2 text-left font-semibold">Created by</th>
                                <th className="px-3 py-2 text-left font-semibold">Status</th>
                                <th className="px-3 py-2 text-left font-semibold">Totals</th>
                                <th className="px-3 py-2 text-left font-semibold">Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {recentJobs.length === 0 && (
                                <tr><td className="px-3 py-3 text-slate-500" colSpan={6}>No jobs in the last 2 days.</td></tr>
                            )}
                            {recentJobs.map(j => (
                                <tr key={j.id} className="odd:bg-white even:bg-slate-50/50 dark:odd:bg-slate-900 dark:even:bg-slate-900/60">
                                    <td className="px-3 py-2 font-mono">{j.id}</td>
                                    <td className="px-3 py-2">{formatIST(j.created_at)}</td>
                                    <td className="px-3 py-2">{j.created_by || "—"}</td>
                                    <td className="px-3 py-2">
                                        <span className="inline-flex items-center rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-xs">
                                            {j.status || "—"}
                                        </span>
                                    </td>
                                    <td className="px-3 py-2">
                                        <span className="text-xs text-slate-600">Total:</span> <strong>{j.total ?? 0}</strong>
                                        <span className="mx-2 text-xs text-slate-400">|</span>
                                        <span className="text-xs text-emerald-700">OK:</span> <strong>{j.ok ?? 0}</strong>
                                        <span className="mx-2 text-xs text-slate-400">|</span>
                                        <span className="text-xs text-rose-700">Err:</span> <strong>{j.error ?? 0}</strong>
                                    </td>
                                    <td className="px-3 py-2">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            {(() => {
                                                const rowStatus = (j.status || "").toLowerCase();
                                                const rowIsRunning = isRunningStatus(rowStatus);
                                                const rowIsPaused  = isPausedStatus(rowStatus);
                                                const rowCanDelete = isTerminalStatus(rowStatus) || rowIsPaused;
                                                return (
                                                  <>
                                                    <button
                                                      type="button"
                                                      onClick={() => (jobId === j.id ? handleHideView() : handleLoadRecent(j.id))}
                                                      className="rounded-md border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-xs hover:bg-slate-100 dark:hover:bg-slate-800"
                                                    >
                                                      {jobId === j.id ? "Hide" : "View"}
                                                    </button>
                                                    {rowIsRunning ? (
                                                      <button
                                                        type="button"
                                                        onClick={() => handlePauseJobClick(j.id)}
                                                        className="rounded-md border border-amber-300 text-amber-700 dark:border-amber-600 px-2.5 py-1 text-xs hover:bg-amber-50 dark:hover:bg-amber-900/20"
                                                      >
                                                        Pause
                                                      </button>
                                                    ) : null}
                                                    {rowIsPaused ? (
                                                      <button
                                                        type="button"
                                                        onClick={() => handleResumeJobClick(j.id)}
                                                        className="rounded-md border border-emerald-300 text-emerald-700 dark:border-emerald-600 px-2.5 py-1 text-xs hover:bg-emerald-50 dark:hover:bg-emerald-900/20"
                                                      >
                                                        Resume
                                                      </button>
                                                    ) : null}
                                                    {rowCanDelete ? (
                                                      <button
                                                        type="button"
                                                        onClick={() => handleDeleteJobClick(j.id)}
                                                        className="rounded-md border border-rose-300 text-rose-700 dark:border-rose-600 px-2.5 py-1 text-xs hover:bg-rose-50 dark:hover:bg-rose-900/20"
                                                      >
                                                        Delete
                                                      </button>
                                                    ) : null}
                                                  </>
                                                );
                                            })()}
                                        </div>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Upload */}
            <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5">
                <label
                    ref={dzRef}
                    className="block cursor-pointer rounded-xl border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/40 p-6 text-center hover:bg-slate-100 dark:hover:bg-slate-800 transition"
                >
                    <input
                        type="file"
                        accept=".xlsx,.xls,.csv"
                        className="hidden"
                        onChange={(e) => onFilePicked(e.target.files?.[0] || null)}
                    />
                    <div className="text-slate-700 dark:text-slate-200 font-medium">Upload for Bulk Processing</div>
                    <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                        Drag &amp; drop or click to choose an Excel/CSV file. We’ll read numbers from the selected column.
                    </div>
                </label>

                {file && (
                    <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
                        <div className="col-span-1 space-y-2">
                            <div className="text-xs uppercase tracking-wide text-slate-500">File</div>
                            <div className="rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm">
                                {file.name}
                            </div>

                            <div className="text-xs uppercase tracking-wide text-slate-500 mt-3">Sheet</div>
                            <select
                                value={activeSheet || ""}
                                onChange={(e) => setActiveSheet(e.target.value)}
                                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm"
                            >
                                {sheetNames.map((n) => (
                                    <option key={n} value={n}>
                                        {n}
                                    </option>
                                ))}
                            </select>

                            <div className="text-xs uppercase tracking-wide text-slate-500 mt-3">Column</div>
                            <select
                                value={selectedCol || ""}
                                onChange={(e) => setSelectedCol(e.target.value)}
                                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm"
                            >
                                {columns.map((c) => (
                                    <option key={c} value={c}>
                                        {c}
                                    </option>
                                ))}
                            </select>

                            <div className="mt-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 p-3 text-sm">
                                <div className="flex items-center justify-between">
                                    <span className="text-slate-600 dark:text-slate-300">Detected items</span>
                                    <span className="font-semibold">{numbers.length}</span>
                                </div>
                                <div className="mt-2 grid grid-cols-4 gap-2 text-xs">
                                    <div className="rounded-md bg-blue-50 dark:bg-blue-900/30 px-2 py-1 text-blue-700 dark:text-blue-200">
                                        Mobile: {detectedCounts.mobile}
                                    </div>
                                    <div className="rounded-md bg-emerald-50 dark:bg-emerald-900/30 px-2 py-1 text-emerald-700 dark:text-emerald-200">
                                        Aadhaar: {detectedCounts.aadhaar}
                                    </div>
                                    <div className="rounded-md bg-orange-50 dark:bg-orange-900/30 px-2 py-1 text-orange-700 dark:text-orange-200">
                                        Application ID: {detectedCounts.application}
                                    </div>
                                    <div className="rounded-md bg-slate-100 dark:bg-slate-800 px-2 py-1 text-slate-700 dark:text-slate-300">
                                        Unknown: {detectedCounts.unknown}
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Controls */}
                        <div className="col-span-2 flex flex-col justify-between h-full">
                            <div className="flex-1" />
                            <div className="flex items-center gap-3">
                                <button
                                    onClick={runProcessing}
                                    disabled={!rows.length}
                                    className="rounded-lg px-4 py-2 font-semibold text-white transition bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    Start Processing
                                </button>
                                {(() => {
                                  // Derive current job status to decide which controls to show
                                  const row = jobId ? recentJobs.find(j => String(j.id) === String(jobId)) : undefined;
                                  const st  = (row?.status || (processing ? "running" : "")) as string;
                                  const isRun = isRunningStatus(st);
                                  const isPause = isPausedStatus(st);
                                  const canDel = isPause || isTerminalStatus(st);
                                  return (
                                    <>
                                      {isRun ? (
                                        <button
                                          onClick={() => jobId && handlePauseJobClick(jobId)}
                                          className="rounded-lg px-4 py-2 font-semibold border border-amber-300 text-amber-700 hover:bg-amber-50 dark:hover:bg-amber-900/20"
                                        >
                                          Pause
                                        </button>
                                      ) : null}
                                      {isPause ? (
                                        <button
                                          onClick={() => jobId && handleResumeJobClick(jobId)}
                                          className="rounded-lg px-4 py-2 font-semibold border border-emerald-300 text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-900/20"
                                        >
                                          Resume
                                        </button>
                                      ) : null}
                                      {canDel ? (
                                        <button
                                          onClick={() => jobId && handleDeleteJobClick(jobId)}
                                          className="rounded-lg px-4 py-2 font-semibold border border-rose-300 text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-900/20"
                                        >
                                          Delete
                                        </button>
                                      ) : null}
                                    </>
                                  );
                                })()}
                            </div>
                        </div>
                    </div>
                )}

                {parseError && (
                    <div className="mt-4 rounded-lg border border-rose-300 bg-rose-50 text-rose-800 px-3 py-2 text-sm">
                        <div className="font-semibold mb-1">Import/Parse Error</div>
                        <div className="whitespace-pre-wrap">{parseError}</div>
                    </div>
                )}
            </div>

            {(jobId || processing || progress.total > 0) && (
                <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5">
                    <div className="flex flex-col sm:flex-row items-center gap-5">
                        {/* Circular progress */}
                        <div className="flex items-center justify-center">
                            {(() => {
                                const size = 96;
                                const stroke = 10;
                                const r = (size - stroke) / 2;
                                const c = 2 * Math.PI * r;
                                const p = Math.max(0, Math.min(100, pct));
                                const dash = (p / 100) * c;
                                return (
                                    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
                                        <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} stroke="currentColor" className="text-slate-200 dark:text-slate-800" fill="none" />
                                        <circle cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} strokeLinecap="round" stroke="currentColor" className="text-indigo-500" fill="none" strokeDasharray={`${dash} ${c - dash}`} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
                                        <text x="50%" y="50%" dominantBaseline="middle" textAnchor="middle" className="fill-slate-700 dark:fill-slate-200 text-sm">
                                            {completedCount}/{progress.total}
                                        </text>
                                    </svg>
                                );
                            })()}
                        </div>
                        {/* Text info */}
                        <div className="flex-1 w-full">
                            <div className="flex items-center justify-between">
                                <div className="text-sm text-slate-700 dark:text-slate-300">
                                    Found <strong>{progress.total}</strong> items to process.
                                    <span className="ml-2">
                                        Done <strong>{completedCount}</strong> / {progress.total}
                                        {processing && completedCount < progress.total ? (
                                            <span> • Processing…{eta ? ` • ETA ${eta}` : ""}</span>
                                        ) : null}
                                    </span>
                                </div>
                                <div className="text-xs text-slate-500">
                                    OK: <span className="font-semibold text-emerald-600">{progress.ok}</span> •&nbsp;
                                    Errors: <span className="font-semibold text-rose-600">{progress.error}</span>
                                </div>
                            </div>
                            <div className="mt-3 h-3 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                                <div className="h-full rounded-full bg-gradient-to-r from-indigo-500 via-sky-500 to-emerald-500 transition-[width] duration-300 ease-out" style={{ width: `${pct}%` }} />
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {/* Live list */}
            {!!rows.length && (
                <div className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-5">
                    <div className="flex items-center justify-between mb-3">
                        <div className="text-sm font-semibold">Job Status</div>
                        <div className="text-xs text-slate-500">
                            Double‑click any row to copy the number
                        </div>
                    </div>
                    <div className="max-h-[420px] overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
                        <table className="min-w-full text-sm">
                            <thead className="sticky top-0 z-10 bg-slate-100 dark:bg-slate-800">
                                <tr>
                                    <th className="px-3 py-2 text-left font-semibold">#</th>
                                    <th className="px-3 py-2 text-left font-semibold">Number</th>
                                    <th className="px-3 py-2 text-left font-semibold">Type</th>
                                    <th className="px-3 py-2 text-left font-semibold">Status</th>
                                    <th className="px-3 py-2 text-left font-semibold">Message</th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((r, idx) => (
                                    <tr
                                        key={r.number}
                                        className="odd:bg-white even:bg-slate-50/50 dark:odd:bg-slate-900 dark:even:bg-slate-900/60"
                                        onDoubleClick={() => {
                                            navigator.clipboard?.writeText(r.number).catch(() => { });
                                        }}
                                    >
                                        <td className="px-3 py-2">{idx + 1}</td>
                                        <td className="px-3 py-2 font-mono">
                                            {r.kind === "aadhaar"
                                                ? formatAadhaar(r.number)
                                                : r.kind === "mobile"
                                                    ? formatMobile(r.number)
                                                    : r.number}
                                        </td>
                                        <td className="px-3 py-2 capitalize">{r.kind}</td>
                                        <td className="px-3 py-2">
                                            {r.status === "pending" && <span className="inline-flex items-center rounded-full bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-xs">Pending</span>}
                                            {r.status === "processing" && <span className="inline-flex items-center rounded-full bg-amber-100 text-amber-800 px-2 py-0.5 text-xs">Processing…</span>}
                                            {r.status === "ok" && <span className="inline-flex items-center rounded-full bg-emerald-100 text-emerald-800 px-2 py-0.5 text-xs">Done</span>}
                                            {r.status === "error" && <span className="inline-flex items-center rounded-full bg-rose-100 text-rose-800 px-2 py-0.5 text-xs">Error</span>}
                                        </td>
                                        <td className="px-3 py-2">{r.message || ""}</td>
                                    </tr>
                                ))}
                                {!rows.length && (
                                    <tr>
                                        <td className="px-3 py-4 text-slate-500">No rows</td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
        </div>
    );
};
export default BulkJobs;