import "dotenv/config";
import express from "express";
import type { Request, Response } from "express";
import cors from "cors";
import axios from "axios";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import { Pool } from "pg";
import { v4 as uuidv4 } from "uuid";

// Use the built-in global fetch (Node 18+). Avoids TS typings for node-fetch.
const fetchFn: typeof fetch = (globalThis as any).fetch;

/* -------------------- env -------------------- */
const PORT = Number(process.env.PORT || 8080);
const GREEN_BASE = process.env.GREENAPI_BASE_URL || "https://api.green-api.com";
const GREEN_INSTANCE = process.env.GREENAPI_INSTANCE_ID!;
const GREEN_TOKEN = process.env.GREENAPI_API_TOKEN!;
const OTP_TTL = Number(process.env.OTP_TTL_SECONDS || 300); // seconds
const OTP_DIGITS = Math.min(Number(process.env.OTP_DIGITS || 6), 8);
const OTP_SECRET = process.env.OTP_SECRET || "dev-secret-change-me";
const AUTH_SECRET = process.env.JWT_SECRET || process.env.AUTH_SECRET || "dev-jwt-change-me";
const DEV_LOG_OTP = process.env.DEV_LOG_OTP === "true";
const ALLOW_UNREGISTERED = (process.env.ALLOW_UNREGISTERED ?? "false") === "true"; // only registered users may login
const TNHORTI_TIMEOUT_MS = Number(process.env.TNHORTI_TIMEOUT_MS || 120000); // default 2 minutes

const DATABASE_URL = process.env.DATABASE_URL;
const PGHOST = process.env.PGHOST;
const PGPORT = Number(process.env.PGPORT || 5432);
const PGDATABASE = process.env.PGDATABASE;
const PGUSER = process.env.PGUSER;
const PGPASSWORD = process.env.PGPASSWORD;

const DEBUG_TN = (process.env.DEBUG_TN === "true");

// TN_MAX_PER_MIN: hard cap of TN requests per minute (default 50)
// BULK_CONCURRENCY: how many job items to process in parallel (default TN_MAX_PER_MIN). TN limiter still caps overall TN calls.

// ---- TN API rate limiter (max N calls per minute) ----
const TN_MAX_PER_MIN = Number(process.env.TN_MAX_PER_MIN || 50);
const BULK_CONCURRENCY = Number(process.env.BULK_CONCURRENCY || TN_MAX_PER_MIN);
const tnCallTimestamps: number[] = [];
async function tnRateGate(): Promise<void> {
  const now = Date.now();
  // drop timestamps older than 60s
  while (tnCallTimestamps.length && now - tnCallTimestamps[0] > 60_000) tnCallTimestamps.shift();
  if (tnCallTimestamps.length < TN_MAX_PER_MIN) {
    tnCallTimestamps.push(now);
    return;
  }
  // wait until the oldest call falls out of the 60s window
  const waitMs = 60_000 - (now - tnCallTimestamps[0]);
  await new Promise((r) => setTimeout(r, Math.max(5, waitMs)));
  return tnRateGate();
}

/* -------------------- app -------------------- */
const app = express();
app.set("trust proxy", 1);
// --- CORS (honor .env CORS_ORIGINS, comma-separated) ---
const allowedOrigins = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow same-origin / server-to-server (no Origin)
    if (!origin) return callback(null, true);
    if (!allowedOrigins.length) return callback(null, true); // fallback: allow all when not configured
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// Explicitly handle preflight
app.options("*", cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (!allowedOrigins.length) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json());

// -------------------- postgres --------------------
const pool = new Pool(
  DATABASE_URL
    ? { connectionString: DATABASE_URL }
    : { host: PGHOST, port: PGPORT, database: PGDATABASE, user: PGUSER, password: PGPASSWORD }
);

/**
 * Minimal users table (PostgreSQL)
 *
 * CREATE TABLE IF NOT EXISTS users (
 *   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *   name TEXT NOT NULL,
 *   phone TEXT NOT NULL UNIQUE
 * );
 * -- store phone in any format; lookup uses last 10 digits
 */

/* -------------------- minimal data layer (stub) -------------------- */
// Replace these with your actual DB queries
export type User = { id: string; phone: string; status: "active"|"suspended"; platform_role?: string|null; name?: string|null };
async function getUserByPhone(phone10: string): Promise<User | null> {
  if (ALLOW_UNREGISTERED) {
    return { id: crypto.randomUUID(), phone: phone10, status: "active", platform_role: null };
  }
  // Look up by last 10 digits of any stored value (handles +91, spaces, etc.)
  const sql = `
    SELECT id::text, name, phone
    FROM users
    WHERE RIGHT(regexp_replace(phone, '[^0-9]', '', 'g'), 10) = $1
    LIMIT 1
  `;
  const { rows } = await pool.query(sql, [phone10]);
  if (!rows[0]) return null;
  return { id: rows[0].id, phone: phone10, status: "active", platform_role: null, name: rows[0].name ?? null };
}
async function getMemberships(_userId: string) {
  return [] as any[]; // wire your org memberships here
}

/* -------------------- helpers -------------------- */
function normalizePhoneE164(input: string): string {
  const digits = (input || "").replace(/\D/g, "");
  // keep last 10 digits; drop leading +91/91/0
  return digits.replace(/^\+?91/, "").replace(/^0/, "").slice(-10);
}
function toChatId(phone10: string) {
  return `91${phone10}@c.us`;
}
function genOtp() {
  const max = 10 ** OTP_DIGITS;
  const n = crypto.randomInt(0, max);
  return String(n).padStart(OTP_DIGITS, "0");
}
function hash(phone10: string, code: string) {
  return crypto.createHmac("sha256", OTP_SECRET).update(`${phone10}:${code}`).digest("hex");
}

/**
 * Classify an input as Mobile (10 digits) or Aadhaar (12 digits), and return a normalized value.
 * Rules:
 *  - Mobile: accept numbers with +91 / 91 / 0 prefixes; take the last 10 digits.
 *  - Aadhaar: exactly 12 digits (raw 12-digit ID). We do NOT treat "91xxxxxxxxxx" as Aadhaar because we strip 91 for mobiles.
 *  - Otherwise invalid.
 */
function classifyInputNumber(raw: string): { kind: "mobile" | "aadhaar" | "invalid"; normalized?: string } {
  const s = String(raw || "").trim();
  const digits = s.replace(/\D/g, "");

  // Aadhaar FIRST: exactly 12 digits AND not explicitly prefixed like a phone (+91/91/0) in the original string
  if (digits.length === 12 && !/^\s*(\+?91|0)/.test(s)) {
    return { kind: "aadhaar", normalized: digits };
  }

  // Mobile: exactly 10 digits
  if (/^\d{10}$/.test(digits)) {
    return { kind: "mobile", normalized: digits };
  }

  // Mobile with +91 / 91 / 0 prefix in the ORIGINAL string → take last 10 digits
  if (/^\s*(\+?91|0)/.test(s)) {
    const last10 = digits.slice(-10);
    if (last10.length === 10) {
      return { kind: "mobile", normalized: last10 };
    }
  }

  return { kind: "invalid" };
}

// Parse TN status date strings into a proper JS Date (UTC), interpreting times as IST (Asia/Kolkata).
function parseStatusDateToISO(raw?: string | null): string | null {
  if (!raw) return null;
  const s = String(raw).trim();

  // IST helper: interpret the provided wall-clock as Asia/Kolkata and convert to UTC ISO.
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000; // +05:30
  const toISOFromIST = (y: number, m: number, d: number, H: number, M: number, S: number) => {
    // Build a UTC date from the parts, then subtract IST offset to get actual UTC instant.
    const utcMs = Date.UTC(y, m - 1, d, H, M, S || 0) - IST_OFFSET_MS;
    return new Date(utcMs).toISOString();
  };

  // Try DD-MM-YYYY HH:mm:ss AM/PM
  let m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (m) {
    const [ , dd, MM, yyyy, hh, mm, ss, ap ] = m;
    const year = (yyyy.length === 2 ? Number(yyyy) + 2000 : Number(yyyy));
    let H = Number(hh) % 12;
    if (/PM/i.test(ap)) H += 12;
    return toISOFromIST(year, Number(MM), Number(dd), H, Number(mm), ss ? Number(ss) : 0);
  }

  // Try DD-MM-YYYY HH:mm:ss (24h)
  m = s.match(/^(\d{1,2})-(\d{1,2})-(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const [ , dd, MM, yyyy, HH, mm, ss ] = m;
    const year = (yyyy.length === 2 ? Number(yyyy) + 2000 : Number(yyyy));
    return toISOFromIST(year, Number(MM), Number(dd), Number(HH), Number(mm), ss ? Number(ss) : 0);
  }

  // Try D/M/YY[YY] HH:mm (24h)
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const [ , dd, MM, yyyy, HH, mm, ss ] = m;
    const year = (yyyy.length === 2 ? Number(yyyy) + 2000 : Number(yyyy));
    return toISOFromIST(year, Number(MM), Number(dd), Number(HH), Number(mm), ss ? Number(ss) : 0);
  }

  // Try D/M/YY[YY] without time -> midnight IST
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    const [ , dd, MM, yyyy ] = m;
    const year = (yyyy.length === 2 ? Number(yyyy) + 2000 : Number(yyyy));
    return toISOFromIST(year, Number(MM), Number(dd), 0, 0, 0);
  }

  // Fallback: let Date try; assume the produced local time is IST-like. We still coerce to ISO.
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    // If the parsed date appears to be in local timezone, adjust as IST -> UTC
    // Use the same conversion approach: treat the wall-clock parts as IST.
    const y = d.getFullYear(), mon = d.getMonth() + 1, day = d.getDate(), H = d.getHours(), M = d.getMinutes(), S = d.getSeconds();
    return toISOFromIST(y, mon, day, H, M, S);
  }

  return null;
}

/* -------------------- in-memory store -------------------- */
type StoreEntry = { hash: string; expiresAt: number; tries: number };
const store = new Map<string, StoreEntry>(); // key = phone10

/* ---------------- TN Horti helpers ---------------- */
const TN_BASE = "https://tnhorticulture.tn.gov.in:8080";
const COMMON_HEADERS = {
  "Content-Type": "application/json; charset=UTF-8",
  "Accept": "application/json, text/javascript, */*; q=0.01",
  "Origin": TN_BASE,
  "X-Requested-With": "XMLHttpRequest",
} as const;

async function tnPost(path: string, payload: any, referer: string) {
  const url = `${TN_BASE}${path}`;
  if (DEBUG_TN) { console.log(`[tnPost] -> POST ${TN_BASE}${path} referer=${referer} payload=`, JSON.stringify(payload)); }
  try {
    await tnRateGate(); // enforce global TN max-per-minute
    const r = await axios.post(url, payload, {
      headers: { ...COMMON_HEADERS, Referer: `${TN_BASE}${referer}` },
      timeout: TNHORTI_TIMEOUT_MS,
      validateStatus: (s) => s >= 200 && s < 300, // only 2xx; others will be caught
    });
    const outer = r?.data;
    const inner = typeof outer?.data === "string" ? JSON.parse(outer.data) : outer;
    return inner || {};
  } catch (err: any) {
    const status = err?.response?.status;
    console.warn(`[tnPost] ${TN_BASE}${path} failed${status ? ` (status ${status})` : ""}:`, err?.message || err);
    return {};
  }
}

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
  mobile?: string | null;
  aadhaar?: string | null;
  has_statuses?: boolean; // computed by server when listing by number
  district?: string | null;
  block?: string | null;
  village?: string | null;
};

type StatusRow = { status_date?: string | null; status?: string; remarks?: string; components?: string; name?: string };

/* ---------------- DB helpers (Postgres) ---------------- */
async function upsertApplications(rows: (AppRow & { source: string })[]) {
  if (!rows?.length) return;
  const client = await pool.connect();
  try {
    const text = `
      INSERT INTO applications (
        application_id, crop_type, mi_name, applied_date, farmer_name,
        mi_area, total_area, survey_no, subdivision_no, farmer_type, ss,
        source, mobile, aadhaar, district, block, village, updated_at
      )
      VALUES ${rows.map((_, i) =>
        `($${i*17+1},$${i*17+2},$${i*17+3},$${i*17+4},$${i*17+5},$${i*17+6},$${i*17+7},$${i*17+8},$${i*17+9},$${i*17+10},$${i*17+11},$${i*17+12},$${i*17+13},$${i*17+14},$${i*17+15},$${i*17+16},$${i*17+17}, now())`
      ).join(",")}
      ON CONFLICT (application_id) DO UPDATE SET
        crop_type = COALESCE(EXCLUDED.crop_type, applications.crop_type),
        mi_name = COALESCE(EXCLUDED.mi_name, applications.mi_name),
        applied_date = COALESCE(EXCLUDED.applied_date, applications.applied_date),
        farmer_name = COALESCE(EXCLUDED.farmer_name, applications.farmer_name),
        mi_area = COALESCE(EXCLUDED.mi_area, applications.mi_area),
        total_area = COALESCE(EXCLUDED.total_area, applications.total_area),
        survey_no = COALESCE(EXCLUDED.survey_no, applications.survey_no),
        subdivision_no = COALESCE(EXCLUDED.subdivision_no, applications.subdivision_no),
        farmer_type = COALESCE(EXCLUDED.farmer_type, applications.farmer_type),
        ss = COALESCE(EXCLUDED.ss, applications.ss),
        source = COALESCE(EXCLUDED.source, applications.source),
        mobile = COALESCE(applications.mobile, EXCLUDED.mobile),
        aadhaar = COALESCE(applications.aadhaar, EXCLUDED.aadhaar),
        district = COALESCE(applications.district, EXCLUDED.district),
        block    = COALESCE(applications.block, EXCLUDED.block),
        village  = COALESCE(applications.village, EXCLUDED.village),
        updated_at = now();
    `;
    const values = rows.flatMap(r => [
      r.application_id, r.crop_type ?? null, r.mi_name ?? null, r.applied_date ?? null, r.farmer_name ?? null,
      r.mi_area ?? null, r.total_area ?? null, r.survey_no ?? null, r.subdivision_no ?? null, r.farmer_type ?? null,
      r.ss ?? null, r.source, r.mobile ?? null, r.aadhaar ?? null, r.district ?? null, r.block ?? null, r.village ?? null
    ]);
    await client.query(text, values);
  } finally { client.release(); }
}

// Upsert only district/block/village for a single application
async function upsertApplicationMeta(appId: string, meta: { district?: string | null; block?: string | null; village?: string | null }) {
  const { district = null, block = null, village = null } = meta || {};
  await pool.query(
    `UPDATE applications
       SET district = COALESCE($2, district),
           block    = COALESCE($3, block),
           village  = COALESCE($4, village),
           updated_at = now()
     WHERE application_id = $1`,
    [appId, district, block, village]
  );
}

// Helper: Normalize/replace application_surveys for an appId based on surveyNo/subdivisionNo
async function replaceApplicationSurveys(appId: string, surveyNo?: string | null, subdivisionNo?: string | null) {
  // Parse surveyNo like "362/3 , 363/3" into individual rows.
  const tokens: { svy: string; sub?: string | null }[] = [];
  const raw = (surveyNo || "").replace(/\s+/g, " ").trim();
  if (raw) {
    for (const part of raw.split(/[,|;]/).map(s => s.trim()).filter(Boolean)) {
      tokens.push({ svy: part, sub: subdivisionNo || null });
    }
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM application_surveys WHERE application_id = $1", [appId]);
    if (tokens.length) {
      const text = `
        INSERT INTO application_surveys (application_id, survey_no, subdivision_no)
        VALUES ${tokens.map((_, i) => `($1, $${i*2+2}, $${i*2+3})`).join(",")}
        ON CONFLICT (application_id, survey_no, subdivision_no) DO NOTHING
      `;
      const values: any[] = [appId, ...tokens.flatMap(t => [t.svy, t.sub ?? null])];
      await client.query(text, values);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function replaceStatuses(appId: string, items: StatusRow[]) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM statuses WHERE application_id = $1", [appId]);
    if (items.length) {
      const text = `
        INSERT INTO statuses (application_id, status_date, status, remarks, components, name)
        VALUES ${items.map((_, i) => `($1,$${i*5+2},$${i*5+3},$${i*5+4},$${i*5+5},$${i*5+6})`).join(",")}
      `;
      const vals: any[] = [ appId as any ];
      for (const s of items) {
        vals.push(s.status_date ?? null, s.status ?? null, s.remarks ?? null, s.components ?? null, s.name ?? null);
      }
      await client.query(text, vals);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function getApplicationsByNumber(number: string) {
  const isAadhaar = number.length === 12;
  const sql = `
    SELECT a.application_id, a.crop_type, a.mi_name, a.applied_date, a.farmer_name,
           a.mi_area, a.total_area, a.survey_no, a.subdivision_no, a.farmer_type, a.ss,
           a.mobile, a.aadhaar, a.district, a.block, a.village,
           EXISTS (SELECT 1 FROM statuses s WHERE s.application_id = a.application_id) AS has_statuses
    FROM applications a
    WHERE ${isAadhaar ? "a.aadhaar = $1" : "a.mobile = $1"}
    ORDER BY a.updated_at DESC
  `;
  const { rows } = await pool.query(sql, [number]);
  return rows as (AppRow & { has_statuses: boolean })[];
}

async function hasStatuses(appId: string) {
  const { rows } = await pool.query("SELECT 1 FROM statuses WHERE application_id = $1 LIMIT 1", [appId]);
  return !!rows[0];
}

async function getStatuses(appId: string) {
  const { rows } = await pool.query(
    "SELECT status_date, status, remarks, components, name FROM statuses WHERE application_id = $1 ORDER BY status_date DESC NULLS LAST, id DESC",
    [appId]
  );
  return rows as any[];
}

async function fetchAppsByNumberFromTN(number: string) {
  if (DEBUG_TN) console.log(`[fetchAppsByNumberFromTN] input=${number}`);
  const isAadhaar = number.length === 12;

  // TN uses Aadhaar endpoint for both mobile & Aadhaar lookups, but we've seen two spellings used in production:
  //   - get_search_application_status_by_aadhaar  (double 'a')
  //   - get_search_application_status_by_aadhar   (single 'a')
  // Try both in order; same referer.
  const referer = "/Subsidy/TrackAadhar";
  const payload = { xformVars: [{ name: "txtSearchAadhar", value: number }] };

  const candidates = [
    "/HttpServiceLogin/get_search_application_status_by_aadhaar", // double 'a' (common)
    "/HttpServiceLogin/get_search_application_status_by_aadhar",  // single 'a' (observed fallback)
  ];

  let rows: any[] = [];
  for (const path of candidates) {
    const inner = await tnPost(path, payload, referer);
    const table = Array.isArray((inner as any)?.Table) ? (inner as any).Table : [];
    if (DEBUG_TN) console.log(`[fetchAppsByNumberFromTN] tried ${path} -> ${table.length} rows`);
    if (table.length) { rows = table; break; }
  }

  if (!rows.length) return [];

  const mapped = rows.map((t: any) => ({
    application_id: t.application_id,
    crop_type: t.crop_type,
    mi_name: t.mi_name,
    applied_date: t.applied_date,
    farmer_name: t.farmer_name,
    mi_area: t.mi_area ?? null,
    total_area: t.total_area ?? null,
    survey_no: t.survey_no,
    subdivision_no: t.subdivision_no,
    farmer_type: t.farmer_type,
    ss: t.ss,
    source: "number",
    mobile: isAadhaar ? null : number,
    aadhaar: isAadhaar ? number : null,
    district: null,
    block: null,
    village: null,
  })) as (AppRow & { source: string })[];

  // Also sync application_surveys for each mapped row
  try {
    for (const app of mapped) {
      await replaceApplicationSurveys(app.application_id, app.survey_no, app.subdivision_no);
    }
  } catch (e) {
    console.warn("[fetchAppsByNumberFromTN] survey upsert failed:", (e as any)?.message || e);
  }

  return mapped;
}
// Fetch TN Print page and extract District, Block, Village, and upsert into DB
async function fetchAndStorePrintMeta(appId: string) {
  try {
    const url = `${TN_BASE}/Print/PrintApplication/${encodeURIComponent(appId)}`;
    const r = await fetchFn(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-IN,en;q=0.9",
        "Cache-Control": "no-cache",
        "Referer": `${TN_BASE}/Subsidy/TrackApplication`,
      },
    });
    if (!r.ok) {
      if (DEBUG_TN) console.warn(`[print-meta] upstream status ${r.status} for ${appId}`);
      return;
    }
    const html = await r.text();

    // Very defensive parsing: try multiple label variants and table layouts
    const pick = (labelRe: RegExp): string | null => {
      // Match: <td>District</td><td>VALUE</td> or with strong/labels
      const tdRe = new RegExp(labelRe.source + String.raw`[^<]*</td>\s*<td[^>]*>\s*([^<]+)`, "i");
      const m1 = html.match(tdRe);
      if (m1?.[1]) return m1[1].trim();

      // Alternate: "District :" in one cell then value in next div/span
      const altRe = new RegExp(labelRe.source + String.raw`[^<]*[:\-]?\s*</[^>]+>\s*<[^>]+>\s*([^<]+)`, "i");
      const m2 = html.match(altRe);
      if (m2?.[1]) return m2[1].trim();

      // Fallback: label and value within same cell "District : VALUE"
      const inlineRe = new RegExp(labelRe.source + String.raw`[^<:]*[:\-]\s*([^<]+)`, "i");
      const m3 = html.match(inlineRe);
      if (m3?.[1]) return m3[1].trim();

      return null;
    };

    const district =
      pick(/<[^>]*>\s*District\s*<[^>]*>/i) ||
      pick(/District/i);
    const block =
      pick(/<[^>]*>\s*Block\s*<[^>]*>/i) ||
      pick(/Block/i);
    const village =
      pick(/<[^>]*>\s*Village\s*<[^>]*>/i) ||
      pick(/Village/i);

    if (district || block || village) {
      await upsertApplicationMeta(appId, {
        district: district ?? null,
        block: block ?? null,
        village: village ?? null,
      });
    }
  } catch (e) {
    if (DEBUG_TN) console.warn("[print-meta] failed for", appId, e);
  }
}

// Helper: fetch statuses from TN and persist them for an application
async function fetchAndStoreStatuses(appId: string) {
  if (DEBUG_TN) console.log(`[fetchAndStoreStatuses] appId=${appId}`);
  let items: StatusRow[] = [];
  try {
    const inner = await tnPost(
      "/HttpServiceLogin/get_search_application_status",
      { xformVars: [{ name: "txtSearchAppId", value: appId }, { name: "StatusType", value: "1" }] },
      "/Subsidy/TrackApplication"
    );
    const table: any[] = Array.isArray((inner as any)?.Table) ? (inner as any).Table : [];
    items = table.map(r => ({
      status_date: parseStatusDateToISO(r.status_date) ?? null, // ← ensure type matches (string | null)
      status: r.status,
      remarks: r.remarks,
      components: r.components,
      name: r.name,
    }));
  } catch (e: any) {
    console.warn(`[fetchAndStoreStatuses] appId=${appId} failed:`, e?.message || e);
    items = [];
  }
  await upsertApplications([
    { application_id: appId, source: "application", ss: items?.[0]?.status ?? null, mobile: null, aadhaar: null } as any,
  ]);
  await replaceStatuses(appId, items);
  // Also refresh surveys if we later attach them elsewhere (no-op here).
  return items;
}

/* -------------------- routes -------------------- */
app.get("/health", (_req: Request, res: Response) => res.json({ ok: true }));

// ==== SEND OTP (uses your exact logic) ====
app.post("/auth/send-otp", async (req: Request, res: Response) => {
  try {
    const phone = normalizePhoneE164(req.body?.phone || "");

    // Authorization pre-check (users table)
    const user = await getUserByPhone(phone);
    if (!user) {
      return res.status(403).json({ ok: false, code: "no_access", message: "User doesn't have access. Please contact admin." });
    }
    if (user.status === "suspended") {
      return res.status(403).json({ ok: false, code: "no_access", message: "User doesn't have access. Please contact admin." });
    }

    // Simple rate limit: max 5 OTPs per 1 minute per phone
    (store as any)._rl = (store as any)._rl || new Map<string, number[]>();
    const rlMap: Map<string, number[]> = (store as any)._rl;
    const nowMs = Date.now();
    const windowMs = 60 * 1000;   // 1 minute
    const arr = rlMap.get(phone) || [];
    const recent = arr.filter(t => nowMs - t < windowMs);
    if (recent.length >= 5) return res.status(429).json({ ok: false, message: "Too many OTP requests. Try again later." });
    recent.push(nowMs);
    rlMap.set(phone, recent);

    const code = genOtp();
    const digest = hash(phone, code);
    store.set(phone, { hash: digest, expiresAt: Date.now() + OTP_TTL * 1000, tries: 0 });

    const message =
      `Your Sri Lakshmi Agro login code is *${code}*.\n` +
      `It expires in ${Math.round(OTP_TTL / 60)} min.\n` +
      `If you didn’t request this, ignore this message.`;

    const url = `${GREEN_BASE}/waInstance${GREEN_INSTANCE}/SendMessage/${GREEN_TOKEN}`;
    await axios.post(url, { chatId: toChatId(phone), message });

    if (DEV_LOG_OTP) console.log(`[DEV] OTP for ${phone}: ${code}`);

    res.json({ ok: true });
  } catch (err: any) {
    console.error("send-otp error:", err?.response?.data || err.message);
    const status = err?.response?.status || 400;
    const message = err?.errors?.[0]?.message || err?.response?.data?.message || err?.message || "Unable to send OTP";
    res.status(status).json({ ok: false, message });
  }
});

// ==== VERIFY OTP (uses your exact logic) ====
app.post("/auth/verify-otp", async (req: Request, res: Response) => {
  try {
    const phone = normalizePhoneE164(req.body?.phone || "");
    const code = String(req.body?.otp ?? req.body?.code ?? "");
    if (!/^\d{4,8}$/.test(code)) throw new Error("Invalid code");

    const entry = store.get(phone);
    if (!entry) return res.status(400).json({ ok: false, message: "Code expired. Request a new one." });

    if (entry.expiresAt < Date.now()) {
      store.delete(phone);
      return res.status(400).json({ ok: false, message: "Code expired. Request a new one." });
    }

    if (entry.tries >= 5) {
      store.delete(phone);
      return res.status(429).json({ ok: false, message: "Too many attempts. Request a new code." });
    }

    entry.tries++;

    const digest = hash(phone, code);
    if (digest !== entry.hash) {
      return res.status(400).json({ ok: false, message: "Invalid code." });
    }

    // Success: one-time use
    store.delete(phone);

    // User + memberships for authorization context
    const user = await getUserByPhone(phone);
    if (!user) {
      return res.status(403).json({ ok: false, code: "no_access", message: "User doesn't have access. Please contact admin." });
    }
    if (user.status === "suspended") {
      return res.status(403).json({ ok: false, code: "no_access", message: "User doesn't have access. Please contact admin." });
    }
    const memberships = await getMemberships(user.id);

    // ---- Issue a real JWT ----
    const token = jwt.sign(
      { sub: user.id, phone: user.phone, platformRole: user.platform_role, platform_role: user.platform_role },
      AUTH_SECRET,
      { expiresIn: "12h" }
    );

    return res.json({
      ok: true,
      token,
      user: { id: user.id, name: user.name ?? null, phone: user.phone },
      platformRole: user.platform_role || null,
      memberships,
    });
  } catch (err: any) {
    const status = err?.response?.status || 400;
    const message = err?.message || "Verification failed";
    return res.status(status).json({ ok: false, message });
  }
});

// ---- Authenticated current user ----
app.get("/auth/me", async (req: Request, res: Response) => {
  try {
    const auth = String(req.headers.authorization || "");
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ ok: false, message: "Missing token" });
    const token = m[1];
    const payload: any = jwt.verify(token, AUTH_SECRET);
    const phone10 = normalizePhoneE164(payload?.phone || "");
    const user = await getUserByPhone(phone10);
    if (!user) return res.status(404).json({ ok: false, message: "User not found" });
    return res.json({
      ok: true,
      user: { id: user.id, name: user.name ?? null, phone: user.phone },
      platformRole: user.platform_role || null,
    });
  } catch (e: any) {
    return res.status(401).json({ ok: false, message: "Invalid token" });
  }
});

// ---- Alias for clients that call `/api/users/me`
app.get("/api/users/me", async (req: Request, res: Response) => {
  try {
    const auth = String(req.headers.authorization || "");
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (!m) return res.status(401).json({ ok: false, message: "Missing token" });
    const token = m[1];
    const payload: any = jwt.verify(token, AUTH_SECRET);
    const phone10 = normalizePhoneE164(payload?.phone || "");
    const user = await getUserByPhone(phone10);
    if (!user) return res.status(404).json({ ok: false, message: "User not found" });
    return res.json({
      ok: true,
      user: { id: user.id, name: user.name ?? null, phone: user.phone },
      platformRole: user.platform_role || null,
    });
  } catch (e: any) {
    return res.status(401).json({ ok: false, message: "Invalid token" });
  }
});

// ---- Unified: Aadhaar/Mobile ----
app.post("/api/search/number", async (req: Request, res: Response) => {
  const raw = String(req.body?.number || req.body?.aadhaar || req.body?.mobile || "");
  const { kind, normalized } = classifyInputNumber(raw);
  const force = Boolean((req.query && (req.query as any).force) || req.body?.force);

  if (!normalized || kind === "invalid") {
    return res.status(400).json({ ok: false, message: "Enter a valid Mobile (10 digits, with/without +91/0) or Aadhaar (12 digits)." });
  }

  console.log(`[search/number] number=${normalized} kind=${kind} force=${force}`);
  let tnCalled = false;

  if (!force) {
    const cached = await getApplicationsByNumber(normalized);
    console.log(`[search/number] cache length=${cached.length}`);
    if (cached.length) {
      for (const app of cached) {
        if (!app.has_statuses) {
          try { await fetchAndStoreStatuses(app.application_id); app.has_statuses = true; }
          catch (e) { console.warn("[/api/search/number] timeline fetch failed for", app.application_id, e); }
        }
        try { await fetchAndStorePrintMeta(app.application_id); } catch {}
      }
      res.setHeader("x-sla-cache", "hit");
      res.setHeader("x-sla-tn", "skipped");
      return res.json({ ok: true, applications: cached, cached: true });
    }
  }

  try {
    console.log(`[search/number] cache-miss -> calling TNHorti`);
    tnCalled = true;
    const mapped = await fetchAppsByNumberFromTN(normalized);
    console.log(`[search/number] TN returned ${mapped.length} rows`);
    if (mapped.length) {
      await upsertApplications(mapped);
      try {
        for (const app of mapped) {
          await replaceApplicationSurveys(app.application_id, app.survey_no, app.subdivision_no);
        }
      } catch (e) {
        console.warn("[/api/search/number] survey upsert failed:", (e as any)?.message || e);
      }
      for (const app of mapped) {
        try { await fetchAndStoreStatuses(app.application_id); } catch (e) { console.warn("[/api/search/number] timeline fetch failed for", app.application_id, e); }
        try { await fetchAndStorePrintMeta(app.application_id); } catch {}
      }
      res.setHeader("x-sla-cache", "miss");
      res.setHeader("x-sla-tn", "called");
      return res.json({ ok: true, applications: mapped, cached: false });
    }
    res.setHeader("x-sla-cache", force ? "bypass" : "miss");
    res.setHeader("x-sla-tn", tnCalled ? "called" : "skipped");
    return res.json({ ok: true, applications: [], cached: false });
  } catch (e: any) {
    console.warn("[/api/search/number] remote fetch failed:", e?.message || e);
    res.setHeader("x-sla-cache", force ? "bypass" : "miss");
    res.setHeader("x-sla-tn", tnCalled ? "called" : "skipped");
    return res.json({ ok: true, applications: [], cached: false });
  }
});

// ---- Timeline by Application ID ----
app.post("/api/search/application", async (req: Request, res: Response) => {
  const appId = String(req.body?.appId || "").trim();
  if (!appId) return res.status(400).json({ ok: false, message: "appId is required." });

  if (await hasStatuses(appId)) {
    const statuses = await getStatuses(appId);
    return res.json({ ok: true, application_id: appId, statuses, cached: true });
  }

  const items = await fetchAndStoreStatuses(appId);
  try { await fetchAndStorePrintMeta(appId); } catch {}

  res.json({ ok: true, application_id: appId, statuses: items, cached: false });
});

// Proxy: TN Horticulture print page → avoid X-Frame-Options block
app.get("/api/tn-print/:id", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).send("Missing application id");

    const upstream = `https://tnhorticulture.tn.gov.in:8080/Print/PrintApplication/${encodeURIComponent(id)}`;

    const r = await fetchFn(upstream, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-IN,en;q=0.9",
        "Cache-Control": "no-cache",
      },
    });

    if (!r.ok) {
      const text = await r.text().catch(() => "");
      return res.status(r.status).send(text || `Upstream error ${r.status}`);
    }

    let html = await r.text();

    // Ensure relative links work
    const baseHref = `https://tnhorticulture.tn.gov.in:8080/`;
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head[^>]*>/i, (m: string) => `${m}<base href="${baseHref}">`);
    } else {
      html = `<head><base href="${baseHref}"></head>` + html;
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    // Don’t forward XFO/CSP from upstream
    res.removeHeader("X-Frame-Options");
    res.removeHeader("Content-Security-Policy");

    return res.status(200).send(html);
  } catch (err: any) {
    return res.status(500).send(err?.message || "Proxy error");
  }
});

/* -------------------- BULK JOBS (DB-backed, persistent) -------------------- */

type BulkJobStatus = "queued" | "running" | "done" | "error" | "canceled";
type BulkItemStatus = "pending" | "processing" | "ok" | "error";

type BulkJobRow = {
  id: string;
  status: BulkJobStatus;
  total: number;
  done: number;
  ok: number;
  error: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
};

async function createBulkJob(total: number): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO bulk_jobs (status, total, done, ok, error)
     VALUES ('queued', $1, 0, 0, 0)
     RETURNING id::text`,
    [total]
  );
  return rows[0].id as string;
}

async function insertBulkItems(jobId: string, numbers: string[]) {
  if (!numbers.length) return;
  const values: any[] = [];
  const tuples: string[] = [];
  let i = 0;
  for (const raw of numbers) {
    const cls = classifyInputNumber(raw);
    const kind = cls.kind === "invalid" ? "unknown" : cls.kind;
    const normalized = cls.normalized ?? raw.replace(/\D/g, "");
    values.push(jobId, normalized, kind, "pending", "");
    tuples.push(`($${i + 1},$${i + 2},$${i + 3},$${i + 4},$${i + 5})`);
    i += 5;
  }
  await pool.query(
    `INSERT INTO bulk_job_items (job_id, number, kind, state, message)
     VALUES ${tuples.join(",")}`,
    values
  );
}

async function getBulkJob(jobId: string): Promise<BulkJobRow | null> {
  const { rows } = await pool.query(
    `SELECT id::text, status, total, done, ok, error,
            created_at::text, updated_at::text
     FROM bulk_jobs
     WHERE id = $1`,
    [jobId]
  );
  const r = rows[0];
  return r ? {
    id: r.id,
    status: r.status,
    total: r.total,
    done: r.done,
    ok: r.ok,
    error: r.error,
    created_at: r.created_at,
    updated_at: r.updated_at,
    started_at: null,
    finished_at: null,
    last_error: r.last_error ?? null,
  } : null;
}

async function getBulkItems(jobId: string, limit = 500) {
  const { rows } = await pool.query(
    `SELECT id, number, kind, state AS status, message, created_at, updated_at
     FROM bulk_job_items
     WHERE job_id = $1
     ORDER BY id ASC
     LIMIT $2`,
    [jobId, limit]
  );
  return rows;
}

async function patchBulkItem(jobId: string, number: string, status: BulkItemStatus, message: string) {
  await pool.query(
    `UPDATE bulk_job_items
     SET state = $3, message = $4, updated_at = now()
     WHERE job_id = $1 AND number = $2`,
    [jobId, number, status, message]
  );
}

async function setJobStatus(jobId: string, status: BulkJobStatus) {
  await pool.query(
    `UPDATE bulk_jobs SET status = $2, updated_at = now() WHERE id = $1`,
    [jobId, status]
  );
}

async function bumpJobCounters(jobId: string, incDone: number, incOk: number, incError: number) {
  await pool.query(
    `UPDATE bulk_jobs
     SET done = done + $2,
         ok   = ok   + $3,
         error= error+ $4,
         updated_at = now()
     WHERE id = $1`,
    [jobId, incDone, incOk, incError]
  );
}

// Use existing search helpers to process one number (cache first, then TN)
async function processOneNumberDB(normalized: string): Promise<{ ok: boolean; message: string }> {
  // 1) try local
  const cached = await getApplicationsByNumber(normalized);
  if (cached.length) {
    for (const app of cached) {
      if (!app.has_statuses) {
        try { await fetchAndStoreStatuses(app.application_id); } catch (e) { console.warn("[bulk] timeline fetch failed:", e); }
      }
    }
    return { ok: true, message: "Already available locally" };
  }
  // 2) TN
  const mapped = await fetchAppsByNumberFromTN(normalized);
  if (mapped.length) {
    await upsertApplications(mapped as any);
    for (const app of mapped) {
      try { await fetchAndStoreStatuses(app.application_id); } catch (e) { console.warn("[bulk] timeline fetch failed:", e); }
    }
    return { ok: true, message: "Fetched from government sources" };
  }
  return { ok: true, message: "No applications found – Farmer hasn’t used the services" };
}

// NOTE: it.number is the classifier's normalized value (12-digit Aadhaar or 10-digit mobile). Do not strip prefixes here.
async function processBulkJob(jobId: string) {
  await setJobStatus(jobId, "running");

  const items = await getBulkItems(jobId, 100000); // all items for this job
  let anyError = false;

  // Concurrency for local+TN processing (rate limiter in tnPost keeps TN at TN_MAX_PER_MIN)
  const WORKERS = Math.max(
    1,
    Math.min(
      // Use BULK_CONCURRENCY (parsed at top), capped at TN_MAX_PER_MIN
      BULK_CONCURRENCY,
      TN_MAX_PER_MIN
    )
  );
  // Sliding-window behaviour:
  // - Start `WORKERS` parallel tasks.
  // - Each task processes one item and then immediately pulls the next queued item.
  // - This keeps ~WORKERS items in-flight at all times (e.g., 50). If some items take minutes,
  //   no new items start until one finishes, maintaining the window. The TN rate gate still
  //   ensures no more than TN_MAX_PER_MIN remote calls per rolling minute.
  let idx = 0;

  const runOne = async () => {
    // pull next item
    const it = items[idx++];
    if (!it) return;

    try {
      await patchBulkItem(jobId, String(it.number), "processing", "Checking local cache…");

      const cls = classifyInputNumber(String(it.number));
      if (cls.kind === "invalid" || !cls.normalized) {
        await patchBulkItem(jobId, String(it.number), "error", "Invalid number format");
        await bumpJobCounters(jobId, 1, 0, 1);
        anyError = true;
        return;
      }

      // cache-first
      const cached = await getApplicationsByNumber(cls.normalized);
      if (cached.length) {
        for (const app of cached) {
          if (!(app as any).has_statuses) {
            try { await fetchAndStoreStatuses((app as any).application_id); } catch (e) { /* ignore */ }
          }
          try { await fetchAndStorePrintMeta((app as any).application_id); } catch {}
        }
        await patchBulkItem(jobId, cls.normalized, "ok", "Already available locally");
        await bumpJobCounters(jobId, 1, 1, 0);
        return;
      }

      await patchBulkItem(jobId, cls.normalized, "processing", "Pulling from government sources…");

      // TN fetch (rate-limited by tnPost)
      const mapped = await fetchAppsByNumberFromTN(cls.normalized);
      if (mapped.length) {
        await upsertApplications(mapped as any);
        for (const app of mapped) {
          try { await fetchAndStoreStatuses(app.application_id); } catch (e) { /* ignore */ }
          try { await fetchAndStorePrintMeta(app.application_id); } catch {}
        }
        await patchBulkItem(jobId, cls.normalized, "ok", "Fetched from government sources");
        await bumpJobCounters(jobId, 1, 1, 0);
      } else {
        await patchBulkItem(jobId, cls.normalized, "ok", "No applications found – Farmer hasn’t used the services");
        await bumpJobCounters(jobId, 1, 1, 0);
      }
    } catch (e: any) {
      anyError = true;
      await patchBulkItem(jobId, String(it.number), "error", e?.message || "Processing failed");
      await bumpJobCounters(jobId, 1, 0, 1);
    } finally {
      // recurse to process the next queued item for this worker
      await runOne();
    }
  };

  // start the worker pool
  await Promise.all(Array.from({ length: Math.min(WORKERS, items.length) }, () => runOne()));

  await setJobStatus(jobId, anyError ? "error" : "done");
}

/* ---------------- Bulk routes (DB-backed) ---------------- */

// List recent bulk jobs (last N days). If you don't scope by user, this returns all recent jobs.
app.get("/api/bulk/recent", async (req: Request, res: Response) => {
  try {
    const days = Math.max(1, Math.min(14, parseInt(String(req.query.days ?? "2"), 10) || 2));

    // Summaries joined with item counts
    const { rows } = await pool.query(
      `
      with job_items as (
        select i.job_id,
               count(*) as total,
               sum(case when lower(coalesce(i.state, '')) in ('ok','success','completed') then 1 else 0 end) as ok,
               sum(case when lower(coalesce(i.state, '')) in ('error','failed','fail') then 1 else 0 end) as error
        from bulk_job_items i
        group by i.job_id
      )
      select b.id::text,
             b.status,
             b.total,
             b.done,
             b.ok,
             b.error,
             b.created_at::text,
             b.updated_at::text,
             coalesce(j.total, 0) as items_total,
             coalesce(j.ok, 0)    as items_ok,
             coalesce(j.error, 0) as items_error
      from bulk_jobs b
      left join job_items j on j.job_id = b.id
      where b.created_at >= (now() at time zone 'UTC') - ($1::int * interval '1 day')
      order by b.created_at desc
      limit 100
      `,
      [days]
    );

    res.json({ ok: true, jobs: rows });
  } catch (e: any) {
    console.error("/api/bulk/recent error:", e);
    res.status(500).json({ ok: false, message: e?.message || "Failed to load recent jobs" });
  }
});

// Latest job (for auto-resume in UI)
app.get("/api/bulk/latest", async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `select id::text, status, total, done, ok, error, created_at::text, updated_at::text
         from bulk_jobs
        order by created_at desc
        limit 1`
    );
    if (!rows.length) return res.json({ ok: true, job: null, jobId: null });
    const j = rows[0];
    return res.json({ ok: true, job: { ...j, started_at: null, finished_at: null }, jobId: j.id });
  } catch (e: any) {
    console.error("/api/bulk/latest error:", e);
    res.status(500).json({ ok: false, message: e?.message || "Failed to load latest job" });
  }
});

// Start bulk job
app.post("/api/bulk/start", async (req: Request, res: Response) => {
  try {
    const raw = req.body?.numbers;
    if (!Array.isArray(raw)) return res.status(400).json({ ok: false, message: "numbers[] required (array of strings)" });

    // Normalize to digit-only strings (we will re-classify again per-item)
    const nums: string[] = raw.map((x: any) => String(x ?? "")).filter(s => s.trim().length > 0);
    if (!nums.length) return res.status(400).json({ ok: false, message: "No numbers to process." });

    const jobId = await createBulkJob(nums.length);
    await insertBulkItems(jobId, nums);

    // async fire-and-forget
    processBulkJob(jobId).catch((e) => console.error("[bulk] processor error:", e));

    return res.json({ ok: true, jobId });
  } catch (e: any) {
    console.error("/api/bulk/start error:", e);
    return res.status(500).json({ ok: false, message: e?.message || "Failed to start bulk job" });
  }
});

// Job status
app.get("/api/bulk/:id/status", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || "");
    const job = await getBulkJob(id);
    if (!job) return res.status(404).json({ ok: false, message: "Job not found" });
    const items = await getBulkItems(id, 1000);
    return res.json({ ok: true, job, items });
  } catch (e: any) {
    console.error("/api/bulk/:id/status error:", e);
    return res.status(500).json({ ok: false, message: e?.message || "Failed to get job status" });
  }
});

// Back-compat alias
app.get("/api/bulk/status/:id", async (req: Request, res: Response) => {
  const id = String(req.params.id || "");
  // delegate
  (app as any)._router.handle({ ...req, url: `/api/bulk/${id}/status`, method: "GET" }, res, () => {});
});

// (Optional) list jobs summary
app.get("/api/bulk", async (_req: Request, res: Response) => {
  const { rows } = await pool.query(
    `SELECT id::text, status, total, done, ok, error, updated_at::text
     FROM bulk_jobs
     ORDER BY created_at DESC
     LIMIT 50`
  );
  res.json({ ok: true, jobs: rows });
});

// (Optional) cancel
app.post("/api/bulk/:id/cancel", async (req: Request, res: Response) => {
  const id = String(req.params.id || "");
  await setJobStatus(id, "canceled");
  res.json({ ok: true });
});

/* -------------------- start -------------------- */
app.listen(PORT, () => {
  console.log(`Sri Lakshmi Agro OTP API listening on :${PORT} (registered users only: ${ALLOW_UNREGISTERED ? "no" : "yes"})`);
});