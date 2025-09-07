import React, { useEffect, useMemo, useRef, useState } from "react";
import * as XLSX from "xlsx";

// ---- API base (same pattern as Login) ----
const API_BASE = (() => {
  const env = (import.meta as any)?.env?.VITE_API_URL || (window as any).__API_URL__ || "";
  return String(env || "").replace(/\/+$/, "");
})();

/** Wrapper that prefixes API_BASE and forces JSON by default */
function apiFetch(path: string, init: RequestInit = {}) {
  const url = `${API_BASE}${path.startsWith("/") ? "" : "/"}${path}`;
  return fetch(url, init);
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
    kind: "mobile" | "aadhaar" | "unknown";
    status: ItemStatus;
    message?: string;
    response?: any;
};

// Classification rules (updated):
// - If exactly 12 digits: Aadhaar (regardless of leading digits)
// - If exactly 10 digits: Mobile
// - If more than 10 digits and last 10 are valid: Mobile (country/leading zero)
// - Else: invalid
function classifyNumber(raw: string): { kind: "mobile" | "aadhaar" | "invalid"; normalized?: string } {
    const s = (raw || "").trim();
    const digits = s.replace(/\D/g, "");
    if (!digits) return { kind: "invalid" };

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
function inferKindFromDigits(num: string): "mobile" | "aadhaar" | "unknown" {
    const d = (num || "").replace(/\D/g, "");
    if (!d) return "unknown";
    if (d.length === 12) return "aadhaar";
    if (d.length === 10) return "mobile";
    if (d.length > 10 && /^\d{10}$/.test(d.slice(-10))) return "mobile";
    return "unknown";
}

const formatAadhaar = (s: string) => {
    const d = s.replace(/\D/g, "");
    return d.replace(/(\d{4})(?=\d)/g, "$1 ");
};
const formatMobile = (s: string) => s.replace(/\D/g, "");

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

const MAX_CONCURRENCY = 3;

const BulkJobs: React.FC = () => {
    const [file, setFile] = useState<File | null>(null);
    const [sheetNames, setSheetNames] = useState<string[]>([]);
    const [activeSheet, setActiveSheet] = useState<string | null>(null);
    const [columns, setColumns] = useState<string[]>([]);
    const [selectedCol, setSelectedCol] = useState<string | null>(null);
    const [columnName, setColumnName] = useState<string>("");
    const [preview, setPreview] = useState<any[][]>([]);

    const [rows, setRows] = useState<ResultRow[]>([]);
    const [parsing, setParsing] = useState(false);
    const [parseError, setParseError] = useState<string | null>(null);

    const [processing, setProcessing] = useState(false);
    const [progress, setProgress] = useState({ total: 0, done: 0, ok: 0, error: 0 });
    const [startedAt, setStartedAt] = useState<number | null>(null);
    const abortRef = useRef<boolean>(false);
    // --- Server mode additions ---
    const [serverMode, setServerMode] = useState(true);
    const [jobId, setJobId] = useState<string | null>(null);

    // --- helpers ---
    function resetAll() {
        setSheetNames([]);
        setActiveSheet(null);
        setColumns([]);
        setSelectedCol(null);
        setPreview([]);
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
            setPreview(aoa.slice(0, 15)); // show a small preview
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
        if (!file || (!selectedCol && !columnName) || !columns.length) return [] as Promise<string[]>;
        let colIdx = -1;
        if (columnName) {
            const want = columnName.trim().toLowerCase();
            colIdx = columns.findIndex(c => c.trim().toLowerCase() === want);
        }
        if (colIdx < 0 && selectedCol) {
            colIdx = columns.indexOf(selectedCol);
        }
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

                    const cls = classifyNumber(originalStr);
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
    }, [file, activeSheet, selectedCol, columns, columnName]);

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
            const cls = classifyNumber(n);
            return {
                number: cls.normalized || n,
                kind: cls.kind === "invalid" ? "unknown" : cls.kind,
                status: "pending",
            };
        });
        setRows(seed);
        setProgress({ total: seed.length, done: 0, ok: 0, error: 0 });
    }, [numbers]);

    // Memoized detected counts for the Detected numbers card
    const detectedCounts = useMemo(() => {
        let mobile = 0, aadhaar = 0, unknown = 0;
        for (const n of numbers) {
            const { kind } = classifyNumber(n);
            if (kind === "mobile") mobile++;
            else if (kind === "aadhaar") aadhaar++;
            else unknown++;
        }
        return { mobile, aadhaar, unknown };
    }, [numbers]);

    // --- Processing ---
    // The original runProcessing is now renamed to runProcessingClient
    async function runProcessingClient() {
        if (!rows.length) return;
        setProcessing(true);
        setStartedAt(Date.now());
        abortRef.current = false;

        // Work queue with limited concurrency
        let done = 0;
        let ok = 0;
        let err = 0;

        const queue = [...rows];
        const next = async () => {
            if (abortRef.current) return;
            const item = queue.shift();
            if (!item) return;

            updateRow(item.number, { status: "processing", message: "Checking local cache…" });

            try {
                const clsForSend = classifyNumber(item.number);
                if (clsForSend.kind === "invalid" || !clsForSend.normalized) {
                    updateRow(item.number, { status: "error", message: "Invalid number format" });
                    done++; setProgress((p) => ({ ...p, done, error: ++err }));
                    if (queue.length) await next();
                    return;
                }
                const searchNumber = clsForSend.normalized;
                const token = localStorage.getItem("sla_token");
                const r = await apiFetch("/api/search/number", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        ...(token ? { Authorization: `Bearer ${token}` } : {}),
                    },
                    body: JSON.stringify({ number: searchNumber }),
                });

                const json = await r.json().catch(() => ({}));
                if (r.ok && json && json.ok !== false) {
                    ok++;
                    let msg = "";
                    const apps = Array.isArray(json.applications) ? json.applications : [];
                    if (apps.length === 0) {
                        msg = "No applications found – Farmer hasn’t used the services";
                    } else if (json.cached === true) {
                        msg = "Already available locally";
                    } else if (apps.length > 0) {
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

                    updateRow(item.number, { status: "ok", message: msg, response: json });
                } else {
                    err++;
                    updateRow(item.number, { status: "error", message: json?.message || `HTTP ${r.status}` });
                }
            } catch (e: any) {
                err++;
                updateRow(item.number, { status: "error", message: e?.message || "Network error" });
            } finally {
                done++;
                setProgress((p) => ({ ...p, done, ok, error: err }));
                if (queue.length) await next();
            }
        };

        // kick off N workers
        await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, rows.length) }, () => next()));

        setProcessing(false);
    }

    // New wrapper for processing, chooses server or client
    async function runProcessing() {
        if (processing) return;
        if (serverMode) {
            if (!rows.length) return;
            setProcessing(true);
            setStartedAt(Date.now());
            setProgress({ total: rows.length, done: 0, ok: 0, error: 0 }); // Seed progress to avoid flash
            try {
                const nums = rows.map(r => r.number);
                const token = localStorage.getItem("sla_token");
                const r = await apiFetch("/api/bulk/start", {
                    method: "POST",
                    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                    body: JSON.stringify({ numbers: nums })
                });

                const ct = (r.headers.get("content-type") || "").toLowerCase();
                let json: any = null;
                if (ct.includes("application/json")) {
                    json = await r.json();
                } else {
                    const text = await r.text();
                    throw new Error(`Non-JSON response from /api/bulk/start (status ${r.status}).\nThis often means a proxy/route issue or an auth redirect returned HTML.\nFirst 200 chars: ${text.slice(0, 200)}`);
                }

                if (!r.ok || json?.ok === false) throw new Error(json?.message || `HTTP ${r.status}`);
                const id = json.jobId as string;
                setJobId(id);
                localStorage.setItem("sla_bulk_last_job", id);
                setRows(rows.map(r => ({ ...r, status: "processing", message: "Queued on server…" })));
            } catch (e: any) {
                setParseError(e?.message || "Failed to start server job.");
                setProcessing(false);
            }
            return;
        }
        // fallback to client mode
        await runProcessingClient();
    }

    function updateRow(num: string, patch: Partial<ResultRow>) {
        setRows((prev) =>
            prev.map((r) => (r.number === num ? { ...r, ...patch } : r))
        );
    }

    function cancel() {
        abortRef.current = true;
        setProcessing(false);
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
    const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
    const eta = useMemo(() => {
        if (!startedAt || progress.done === 0) return null;
        const elapsed = Date.now() - startedAt; // ms
        const perItem = elapsed / progress.done;
        const remaining = (progress.total - progress.done) * perItem;
        return msToNice(remaining);
    }, [startedAt, progress.done, progress.total]);

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
            const last = localStorage.getItem("sla_bulk_last_job");
            if (last) {
                setJobId(last);
                setProcessing(true);
                setRows([]);
                setProgress({ total: 0, done: 0, ok: 0, error: 0 });
            }
            const latest = await fetchLatestServerJobId();
            if (latest && latest !== last) {
                setJobId(latest);
                setProcessing(true);
                setRows([]);
                setProgress({ total: 0, done: 0, ok: 0, error: 0 });
                localStorage.setItem("sla_bulk_last_job", latest);
            }
        })();
    }, [file]);

    // --- Server job polling ---
    // Map backend job-item state to our UI ItemStatus
    function mapStateToStatus(it: any): ItemStatus {
        const state = (it.state ?? it.status ?? "").toString().toLowerCase();
        // Some backends may include a boolean/flag for success or error
        const errLike = Boolean(it.error) || String(it.result || "").toLowerCase() === "error";
        if (state === "queued" || state === "running" || state === "processing") return "processing";
        if (state === "pending") return "pending";
        if (state === "done" || state === "completed" || state === "ok" || state === "success") {
            return errLike ? "error" : "ok";
        }
        if (state === "error" || state === "failed" || state === "fail") return "error";
        // Fallback: if we have an HTTP ok prior, treat as processing until completed
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
                const text = await r.text();
                throw new Error(`Non-JSON response from /api/bulk/${jobId}/status (status ${r.status}).\nLikely a proxy/route miss or auth redirect returned HTML.\nFirst 200 chars: ${text.slice(0, 200)}`);
            }
            if (r.ok && json?.ok) {
                const job = json.job || {};
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
                        if (s === "ok" || s === "error" || s === "pending" || s === "processing") acc[s]++;
                        return acc;
                    }, { ok: 0, error: 0, pending: 0, processing: 0 });
                    ok = counts.ok;
                    error = counts.error;
                    done = ok + error;
                }

                setProgress(prev => ({
                    total: total || prev.total,
                    done,
                    ok,
                    error
                }));

                // Map items to our UI rows
                const mapped: ResultRow[] = items.map((it: any) => {
                    const num = String(it.number ?? it.input ?? "");
                    const backendKind = (it.kind || "").toString().toLowerCase();
                    const kind: "mobile" | "aadhaar" | "unknown" =
                        backendKind === "mobile" || backendKind === "aadhaar"
                            ? (backendKind as any)
                            : inferKindFromDigits(num);
                    return {
                        number: num,
                        kind,
                        status: mapStateToStatus(it),
                        message: it.message || it.last_message || it.detail || ""
                    };
                });

                // Only update rows if items is non-empty
                if (items.length > 0) {
                    setRows(mapped.slice().reverse());
                }

                const jStatus = String(job.status || "").toLowerCase();
                if (["done", "completed", "canceled", "error", "failed"].includes(jStatus)) {
                    setProcessing(false);
                }
            } else {
                // Treat missing/404 as terminal unless transient
                if (r.status === 404) {
                    // Quietly stop viewing; job likely expired/cleaned up
                    setRows([]);
                    setProcessing(false);
                    return;
                }
            }
        } catch (e: any) {
            // Keep polling, but surface the error once
            setParseError(e?.message || "Failed to poll server job status.");
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
    type RecentJob = { id: string; status?: string; created_at?: string; total?: number; done?: number; ok?: number; error?: number; };

    const [recentJobs, setRecentJobs] = useState<RecentJob[]>([]);
    const [loadingRecent, setLoadingRecent] = useState(false);
    const [recentError, setRecentError] = useState<string | null>(null);

    function formatIST(iso?: string) {
        if (!iso) return "";
        try {
            const d = new Date(iso);
            return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
        } catch { return iso; }
    }

    async function fetchRecentServerJobs(days = 2): Promise<RecentJob[]> {
        setLoadingRecent(true);
        setRecentError(null);
        try {
            const token = localStorage.getItem("sla_token");
            // Preferred endpoint
        let r = await apiFetch(`/api/bulk/recent?days=${days}`, {
                headers: { "Accept": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }
            });
            if (r.ok && (r.headers.get("content-type") || "").toLowerCase().includes("application/json")) {
                const json = await r.json();
                const list: any[] = Array.isArray(json?.jobs) ? json.jobs : Array.isArray(json) ? json : [];
                const mapped: RecentJob[] = list.map(it => ({
                    id: String(it.id ?? it.job_id ?? it.jobId ?? ""),
                    status: it.status ?? "",
                    created_at: it.created_at ?? it.started_at ?? it.createdAt ?? it.created ?? "",
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
            setRecentError(e?.message || "Failed to load recent jobs.");
            return [];
        } finally {
            setLoadingRecent(false);
        }
    }

    useEffect(() => {
        (async () => {
            const list = await fetchRecentServerJobs(2);
            setRecentJobs(list);
        })();
    }, []);


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
                const text = await r.text();
                throw new Error(`Non-JSON response from /api/bulk/${id}/status (status ${r.status}).\nLikely a proxy/route miss or auth redirect returned HTML.\nFirst 200 chars: ${text.slice(0, 200)}`);
            }
            if (r.ok && json?.ok) {
                const job = json.job || {};
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
                        if (s === "ok" || s === "error" || s === "pending" || s === "processing") acc[s]++;
                        return acc;
                    }, { ok: 0, error: 0, pending: 0, processing: 0 });
                    ok = counts.ok;
                    error = counts.error;
                    done = ok + error;
                }

                setProgress(prev => ({
                    total: total || prev.total,
                    done,
                    ok,
                    error
                }));

                // Map items to our UI rows
                const mapped: ResultRow[] = items.map((it: any) => {
                    const num = String(it.number ?? it.input ?? "");
                    const backendKind = (it.kind || "").toString().toLowerCase();
                    const kind: "mobile" | "aadhaar" | "unknown" =
                        backendKind === "mobile" || backendKind === "aadhaar"
                            ? (backendKind as any)
                            : inferKindFromDigits(num);
                    return {
                        number: num,
                        kind,
                        status: mapStateToStatus(it),
                        message: it.message || it.last_message || it.detail || ""
                    };
                });

                // Only update rows if items is non-empty
                if (items.length > 0) {
                    setRows(mapped.slice().reverse());
                }

                const jStatus = String(job.status || "").toLowerCase();
                if (["done", "completed", "canceled", "error", "failed"].includes(jStatus)) {
                    setProcessing(false);
                }
            } else {
                // Treat missing/404 as terminal unless transient
                if (r.status === 404) {
                    setParseError("Job not found on server (404). It may have expired.");
                    setProcessing(false);
                }
            }
        } catch (e: any) {
            // Keep polling, but surface the error once
            setParseError(e?.message || "Failed to poll server job status.");
        }
    }

    function handleHideView() {
        // Stop viewing the current job and clear the live rows/progress UI
        setJobId(null);
        setProcessing(false);
        setRows([]);
        setProgress({ total: 0, done: 0, ok: 0, error: 0 });
        // (We keep localStorage so the user can resume later if they choose.)
    }

    function handleLoadRecent(id: string) {
        if (!id) return;
        setJobId(id);
        setProcessing(true);
        setRows([]);
        setProgress({ total: 0, done: 0, ok: 0, error: 0 });
        localStorage.setItem("sla_bulk_last_job", id);
        pollOnceById(id);
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
                            onClick={async () => setRecentJobs(await fetchRecentServerJobs(2))}
                            className="rounded-lg border border-slate-300 dark:border-slate-700 px-3 py-1.5 text-xs bg-slate-50 dark:bg-slate-800 hover:bg-slate-100 dark:hover:bg-slate-700"
                        >
                            Reload List
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
                                <th className="px-3 py-2 text-left font-semibold">Status</th>
                                <th className="px-3 py-2 text-left font-semibold">Totals</th>
                                <th className="px-3 py-2 text-left font-semibold"></th>
                            </tr>
                        </thead>
                        <tbody>
                            {loadingRecent && (
                                <tr><td className="px-3 py-3 text-slate-500" colSpan={5}>Loading…</td></tr>
                            )}
                            {!loadingRecent && recentJobs.length === 0 && (
                                <tr><td className="px-3 py-3 text-slate-500" colSpan={5}>No jobs in the last 2 days.</td></tr>
                            )}
                            {recentJobs.map(j => (
                                <tr key={j.id} className="odd:bg-white even:bg-slate-50/50 dark:odd:bg-slate-900 dark:even:bg-slate-900/60">
                                    <td className="px-3 py-2 font-mono">{j.id}</td>
                                    <td className="px-3 py-2">{formatIST(j.created_at)}</td>
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
                                        <button
                                            type="button"
                                            onClick={() => (jobId === j.id ? handleHideView() : handleLoadRecent(j.id))}
                                            className="rounded-md border border-slate-300 dark:border-slate-700 px-2.5 py-1 text-xs hover:bg-slate-100 dark:hover:bg-slate-800"
                                        >
                                            {jobId === j.id ? "Hide" : "View"}
                                        </button>
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
                            <input
                                type="text"
                                placeholder="Or type column name (header)"
                                value={columnName}
                                onChange={(e) => setColumnName(e.target.value)}
                                className="mt-2 w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 px-3 py-2 text-sm"
                            />
                            <div className="mt-1 text-[11px] text-slate-500">
                                We will prefer an exact (case‑insensitive) header match here if provided; otherwise we use the selected column.
                            </div>

                            <div className="mt-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 p-3 text-sm">
                                <div className="flex items-center justify-between">
                                    <span className="text-slate-600 dark:text-slate-300">Detected numbers</span>
                                    <span className="font-semibold">{numbers.length}</span>
                                </div>
                                <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                                    <div className="rounded-md bg-blue-50 dark:bg-blue-900/30 px-2 py-1 text-blue-700 dark:text-blue-200">
                                        Mobile: {detectedCounts.mobile}
                                    </div>
                                    <div className="rounded-md bg-emerald-50 dark:bg-emerald-900/30 px-2 py-1 text-emerald-700 dark:text-emerald-200">
                                        Aadhaar: {detectedCounts.aadhaar}
                                    </div>
                                    <div className="rounded-md bg-slate-100 dark:bg-slate-800 px-2 py-1 text-slate-700 dark:text-slate-300">
                                        Unknown: {detectedCounts.unknown}
                                    </div>
                                </div>
                            </div>
                        </div>

                        {/* Preview */}
                        <div className="col-span-2">
                            <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">Preview</div>
                            <div className="overflow-auto rounded-lg border border-slate-200 dark:border-slate-700">
                                <table className="min-w-full text-sm">
                                    <thead className="bg-slate-100 dark:bg-slate-800">
                                        <tr>
                                            {preview[0]?.map((h, i) => (
                                                <th key={i} className="px-3 py-2 text-left font-semibold text-slate-700 dark:text-slate-200">
                                                    {String(h ?? `Column ${i + 1}`)}
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {preview.slice(1).map((row, rIdx) => (
                                            <tr key={rIdx} className="odd:bg-white even:bg-slate-50/50 dark:odd:bg-slate-900 dark:even:bg-slate-900/60">
                                                {row.map((c, cIdx) => (
                                                    <td key={cIdx} className="px-3 py-2 text-slate-800 dark:text-slate-200 whitespace-nowrap">
                                                        {c == null ? "" : String(c)}
                                                    </td>
                                                ))}
                                            </tr>
                                        ))}
                                        {!preview.length && (
                                            <tr>
                                                <td className="px-3 py-4 text-slate-500 dark:text-slate-400">No preview available</td>
                                            </tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>

                            {/* Controls */}
                            <div className="mt-4 flex items-center gap-3">
                                <button
                                    onClick={runProcessing}
                                    disabled={!rows.length}
                                    className="rounded-lg px-4 py-2 font-semibold text-white transition bg-blue-600 hover:bg-blue-700 active:bg-blue-800 disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    Start Processing
                                </button>
                                {processing ? (
                                    <button
                                        onClick={cancel}
                                        className="rounded-lg px-4 py-2 font-semibold border border-rose-300 text-rose-700 hover:bg-rose-50 dark:hover:bg-rose-900/20"
                                    >
                                        Cancel
                                    </button>
                                ) : (
                                    <button
                                        onClick={() => onFilePicked(file)}
                                        disabled={!file}
                                        className="rounded-lg px-4 py-2 font-semibold border border-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
                                    >
                                        Re-parse
                                    </button>
                                )}
                            </div>

                            {/* Progress */}
                            {(processing || progress.done > 0) && (
                                <div className="mt-5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-4">
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
                                                        <circle
                                                            cx={size / 2}
                                                            cy={size / 2}
                                                            r={r}
                                                            strokeWidth={stroke}
                                                            stroke="currentColor"
                                                            className="text-slate-200 dark:text-slate-800"
                                                            fill="none"
                                                        />
                                                        <circle
                                                            cx={size / 2}
                                                            cy={size / 2}
                                                            r={r}
                                                            strokeWidth={stroke}
                                                            strokeLinecap="round"
                                                            stroke="currentColor"
                                                            className="text-indigo-500"
                                                            fill="none"
                                                            strokeDasharray={`${dash} ${c - dash}`}
                                                            transform={`rotate(-90 ${size / 2} ${size / 2})`}
                                                        />
                                                        <text
                                                            x="50%"
                                                            y="50%"
                                                            dominantBaseline="middle"
                                                            textAnchor="middle"
                                                            className="fill-slate-700 dark:fill-slate-200 text-sm"
                                                        >
                                                            {Math.min(progress.done, progress.total)}/{progress.total}
                                                        </text>
                                                    </svg>
                                                );
                                            })()}
                                        </div>

                                        {/* Text info */}
                                        <div className="flex-1 w-full">
                                            <div className="flex items-center justify-between">
                                                <div className="text-sm text-slate-700 dark:text-slate-300">
                                                    Found <strong>{progress.total}</strong> numbers to process.
                                                    {processing ? (
                                                        <span className="ml-2">
                                                            Processing <strong>{Math.min(progress.done + 1, progress.total)}</strong> / {progress.total}
                                                            {eta ? ` • ETA ${eta}` : ""}
                                                        </span>
                                                    ) : (
                                                        progress.done > 0 && (
                                                            <span className="ml-2">Completed <strong>{progress.done}</strong> / {progress.total}</span>
                                                        )
                                                    )}
                                                </div>
                                                <div className="text-xs text-slate-500">
                                                    OK: <span className="font-semibold text-emerald-600">{progress.ok}</span> •&nbsp;
                                                    Errors: <span className="font-semibold text-rose-600">{progress.error}</span>
                                                </div>
                                            </div>
                                            <div className="mt-3 h-3 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
                                                <div
                                                    className="h-full rounded-full bg-gradient-to-r from-indigo-500 via-sky-500 to-emerald-500 transition-[width] duration-300 ease-out"
                                                    style={{ width: `${pct}%` }}
                                                />
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            )}
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
                                            {r.kind === "aadhaar" ? formatAadhaar(r.number) : formatMobile(r.number)}
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