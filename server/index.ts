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

// Bulk job retention (days); default 2
const BULK_RETENTION_DAYS = Math.max(1, Math.min(30, Number(process.env.BULK_RETENTION_DAYS || 2)));

// Helper: Prune old bulk jobs and their items (retention in days)
async function pruneOldBulkJobs(retentionDays: number): Promise<{ jobs: number; items: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const itemsDel = await client.query(
      `DELETE FROM bulk_job_items
        WHERE job_id IN (
          SELECT id FROM bulk_jobs WHERE created_at < now() - ($1::int * interval '1 day')
        )`,
      [retentionDays]
    );
    const jobsDel = await client.query(
      `DELETE FROM bulk_jobs
        WHERE created_at < now() - ($1::int * interval '1 day')`,
      [retentionDays]
    );
    await client.query('COMMIT');
    return { jobs: jobsDel.rowCount || 0, items: itemsDel.rowCount || 0 };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[prune] failed:', (e as any)?.message || e);
    return { jobs: 0, items: 0 };
  } finally {
    client.release();
  }
}

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
  if (DEBUG_TN) console.log(`[tnRateGate] throttling for ${Math.ceil(waitMs/1000)}s; queue size=${tnCallTimestamps.length}`);
  await new Promise((r) => setTimeout(r, Math.max(5, waitMs)));
  return tnRateGate();
}
// Rate-gated GET helper for TN endpoints
async function tnFetch(pathOrUrl: string, init?: RequestInit & { referer?: string }) {
  // Accept either full URL or TN-relative path
  const isFull = /^https?:\/\//i.test(pathOrUrl);
  const url = isFull ? pathOrUrl : `${TN_BASE}${pathOrUrl}`;
  const referer = init?.referer || (isFull ? undefined : `${TN_BASE}/`);
  try {
    await tnRateGate(); // enforce global TN max-per-minute
    const r = await fetchFn(url, {
      ...init,
      headers: {
        ...(init?.headers || {}),
        ...(referer ? { Referer: referer } : {}),
      },
    } as any);
    return r;
  } catch (e) {
    if (DEBUG_TN) console.warn('[tnFetch] failed', e);
    throw e;
  }
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

// Upsert district/block/village (and, if provided, mobile) for a single application
async function upsertApplicationMeta(appId: string, meta: { district?: string | null; block?: string | null; village?: string | null; mobile?: string | null }) {
  const { district = null, block = null, village = null, mobile = null } = meta || {};
  await pool.query(
    `
    INSERT INTO applications (application_id, district, block, village, mobile, source, updated_at)
    VALUES ($1, $2, $3, $4, $5, 'application', now())
    ON CONFLICT (application_id) DO UPDATE SET
      district   = COALESCE(applications.district, EXCLUDED.district),
      block      = COALESCE(applications.block,    EXCLUDED.block),
      village    = COALESCE(applications.village,  EXCLUDED.village),
      mobile     = COALESCE(applications.mobile,   EXCLUDED.mobile),
      updated_at = now()
    `,
    [appId, district, block, village, mobile]
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

// Write-through cache: persist application rows, surveys, statuses, and print meta
async function persistAppsSurveysStatusesMeta(apps: (AppRow & { source?: string })[]): Promise<void> {
  if (!Array.isArray(apps) || apps.length === 0) return;
  try {
    // Ensure a source for DB integrity
    const withSource = apps.map(a => ({ ...a, source: a.source || "number" })) as any;
    await upsertApplications(withSource);
  } catch (e) {
    console.warn("[persist] upsertApplications failed:", (e as any)?.message || e);
  }

  // Persist surveys if present; then statuses and print meta for every app (best-effort)
  for (const a of apps) {
    try {
      if ((a as any).survey_no || (a as any).subdivision_no) {
        await replaceApplicationSurveys(a.application_id, (a as any).survey_no, (a as any).subdivision_no);
      }
    } catch (e) {
      console.warn("[persist] survey upsert failed for", a.application_id, (e as any)?.message || e);
    }
    try { await fetchAndStoreStatuses(a.application_id); } catch {}
    try { await fetchAndStorePrintMeta(a.application_id); } catch {}
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

// Helper: read a full application row by application_id, including whether statuses exist
async function getApplicationFullById(appId: string): Promise<(AppRow & { has_statuses: boolean }) | null> {
  const { rows } = await pool.query(
    `SELECT a.application_id, a.crop_type, a.mi_name, a.applied_date, a.farmer_name,
            a.mi_area, a.total_area, a.survey_no, a.subdivision_no, a.farmer_type, a.ss,
            a.mobile, a.aadhaar, a.district, a.block, a.village,
            EXISTS (SELECT 1 FROM statuses s WHERE s.application_id = a.application_id) AS has_statuses
       FROM applications a
      WHERE a.application_id = $1
      LIMIT 1`,
    [appId]
  );
  return rows[0] || null;
}

// Helper: read a single application by ID (to discover mobile/aadhaar from local DB when Print meta doesn’t have it)
async function getApplicationById(appId: string) {
  const { rows } = await pool.query(
    `SELECT application_id, mobile, aadhaar, district, block, village
       FROM applications
      WHERE application_id = $1
      LIMIT 1`,
    [appId]
  );
  return rows[0] || null;
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
  const referer = "/Subsidy/TrackAadhar";
  const payload = { xformVars: [{ name: "txtSearchAadhar", value: number }] };

  const candidates = [
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

  // NOTE: Do not upsert application_surveys here — caller upserts *after* upserting applications to satisfy FK.

  return mapped;
}
// Fetch TN Print page and extract District, Block, Village, and (if present) Mobile; upsert meta and return parsed values
async function fetchAndStorePrintMeta(appId: string): Promise<{ district?: string|null; block?: string|null; village?: string|null; mobile?: string|null } | null> {
  try {
    const url = `${TN_BASE}/Print/PrintApplication/${encodeURIComponent(appId)}`;
    const r = await tnFetch(url, {
      referer: `${TN_BASE}/Subsidy/TrackApplication`,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-IN,en;q=0.9",
        "Cache-Control": "no-cache",
      },
    });
    if (!r.ok) {
      if (DEBUG_TN) console.warn(`[print-meta] upstream status ${r.status} for ${appId}`);
      return null;
    }
    const html = await r.text();

    // Defensive cell-pair extractor
    const pick = (labelRe: RegExp): string | null => {
      const tdRe = new RegExp(labelRe.source + String.raw`[^<]*</td>\s*<td[^>]*>\s*([^<]+)`, "i");
      const m1 = html.match(tdRe);
      if (m1?.[1]) return m1[1].trim();

      const altRe = new RegExp(labelRe.source + String.raw`[^<]*[:\-]?\s*</[^>]+>\s*<[^>]+>\s*([^<]+)`, "i");
      const m2 = html.match(altRe);
      if (m2?.[1]) return m2[1].trim();

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

    // Try to extract a 10-digit mobile from likely spots; fall back to any 10-digit sequence
    const labelMobile =
      pick(/<[^>]*>\s*(Farmer\s*)?Mobile(\s*No\.?)?\s*<[^>]*>/i) ||
      pick(/Mobile(\s*No\.?)?/i);
    let mobile: string | null = null;
    const mobileCandidates: string[] = [];
    if (labelMobile) {
      const digits = labelMobile.replace(/\D/g, "");
      if (digits.length >= 10) mobileCandidates.push(digits.slice(-10));
    }
    // Global scan for any 10-digit group as last resort
    const mAll = html.match(/\b(\d{10})\b/g);
    if (Array.isArray(mAll)) {
      for (const d of mAll) {
        if (/^[6-9]\d{9}$/.test(d)) mobileCandidates.push(d);
      }
    }
    if (mobileCandidates.length) {
      // normalize to last 10
      const norm = normalizePhoneE164(mobileCandidates[0]);
      if (norm && norm.length === 10) mobile = norm;
    }

    if (district || block || village || mobile) {
      await upsertApplicationMeta(appId, {
        district: district ?? null,
        block: block ?? null,
        village: village ?? null,
        mobile: mobile ?? null,
      });
    }

    return { district: district ?? null, block: block ?? null, village: village ?? null, mobile: mobile ?? null };
  } catch (e) {
    if (DEBUG_TN) console.warn("[print-meta] failed for", appId, e);
    return null;
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
      await persistAppsSurveysStatusesMeta(mapped as any);
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
  // Do not allow browser/proxy caching for dynamic results
  res.setHeader("Cache-Control", "no-store");

  const appId = String(req.body?.appId || "").trim();
  if (!appId) return res.status(400).json({ ok: false, message: "appId is required." });

  // 0) If this Application ID already exists locally, serve from DB first
  let localApp: (AppRow & { has_statuses: boolean }) | null = null;
  try { localApp = await getApplicationFullById(appId); } catch { localApp = null; }

  if (localApp) {
    // Known locally → prefer DB for everything; no TN unless timelines missing
    let foundMobileLocal: string = "";
    if (localApp.mobile) {
      const m = normalizePhoneE164(String(localApp.mobile));
      if (m && m.length === 10) foundMobileLocal = m;
    }

    // Fetch all apps for this farmer by mobile (if present) from LOCAL DB only
    let applications_from_mobile: AppRow[] = [];
    if (foundMobileLocal) {
      try { applications_from_mobile = await getApplicationsByNumber(foundMobileLocal); } catch { applications_from_mobile = []; }
    }

    // Ensure statuses for this App ID (DB-first)
    let statuses: StatusRow[] = [];
    try {
      if (await hasStatuses(appId)) { statuses = await getStatuses(appId); }
      else { statuses = await fetchAndStoreStatuses(appId); }
    } catch { statuses = []; }

    return res.json({
      ok: true,
      application_id: appId,
      meta: {
        district: localApp.district ?? null,
        block: localApp.block ?? null,
        village: localApp.village ?? null,
        mobile: foundMobileLocal || null,
      },
      statuses,
      mobile_used: foundMobileLocal || null,
      applications_from_mobile,
    });
  }

  // 1) LOCAL FIRST: try to read mobile + district/block/village from our DB
  let localRow: { mobile?: string | null; aadhaar?: string | null; district?: string | null; block?: string | null; village?: string | null } | null = null;
  try { localRow = await getApplicationById(appId); } catch { localRow = null; }

  let district: string | null = localRow?.district ?? null;
  let block: string | null = localRow?.block ?? null;
  let village: string | null = localRow?.village ?? null;
  let foundMobile: string = "";

  if (localRow?.mobile) {
    const m = normalizePhoneE164(String(localRow.mobile));
    if (m && m.length === 10) foundMobile = m;
  }

  // 2) Only if any of the meta/mobile is missing, hit the TN Print page ONCE to enrich
  //    (and persist for future searches). We are enriching basics and then using mobile to call the government aadhar endpoint.
  if (!foundMobile || !district || !block || !village) {
    try {
      const meta = await fetchAndStorePrintMeta(appId);
      if (meta) {
        district = district ?? (meta.district ?? null);
        block    = block    ?? (meta.block ?? null);
        village  = village  ?? (meta.village ?? null);
        if (!foundMobile && meta.mobile) {
          const m = normalizePhoneE164(meta.mobile);
          if (m && m.length === 10) foundMobile = m;
        }
      }
    } catch {
      // ignore print meta failure; we still return whatever we have
    }
  }

  // 3) If we have a mobile, prefer LOCAL cache; call TN only when needed to fill gaps
  //    (needed when: no local rows, or any row missing crop/mi/applied_date/farmer_name/areas/survey info)
  let applications_from_mobile: AppRow[] = [];
  if (foundMobile && foundMobile.length === 10) {
    try {
      const requiredFields: Array<keyof AppRow> = [
        "crop_type",
        "mi_name",
        "applied_date",
        "farmer_name",
        "mi_area",
        "total_area",
        "survey_no",
        "subdivision_no",
        "farmer_type",
        "ss"
      ];

      // 1) LOCAL FIRST
      const cached = await getApplicationsByNumber(foundMobile);
      const hasLocal = Array.isArray(cached) && cached.length > 0;

      const needsEnrichment = hasLocal && cached.some((a: any) =>
        requiredFields.some((k) => (a as any)[k] == null || (a as any)[k] === "")
      );

      if (!hasLocal || needsEnrichment) {
        // 2) TN ONLY WHEN NEEDED — populate rich fields
        const mapped = await fetchAppsByNumberFromTN(foundMobile);
        if (mapped.length) {
          await persistAppsSurveysStatusesMeta(mapped as any);
          applications_from_mobile = mapped;
        } else {
          // TN gave nothing → keep whatever we have locally
          applications_from_mobile = cached as any;
        }
      } else {
        // 3) Local rows are complete → no TN call
        applications_from_mobile = cached as any;
      }
    } catch {
      // swallow – we'll still return statuses/meta for the requested app
    }
  }

  // 4) Ensure statuses for the requested Application ID from local DB first
  let statuses: StatusRow[] = [];
  try {
    if (await hasStatuses(appId)) {
      statuses = await getStatuses(appId);
    } else {
      statuses = await fetchAndStoreStatuses(appId);
    }
  } catch { statuses = []; }

  // 5) Respond – never 5xx just because upstream has no data
  const isEmpty = (!statuses || !statuses.length) && (!applications_from_mobile || !applications_from_mobile.length);

  return res.json({
    ok: true,
    application_id: appId,
    meta: {
      district: district ?? null,
      block: block ?? null,
      village: village ?? null,
      mobile: foundMobile || null,
    },
    statuses,
    mobile_used: foundMobile || null,
    applications_from_mobile,
    ...(isEmpty ? { message: "No Data" } : {})
  });
});

// Back-compat alias: /api/search/appid → /api/search/application
app.post("/api/search/appid", (req: Request, res: Response) => {
  (app as any)._router.handle({ ...req, url: "/api/search/application", method: "POST" }, res, () => {});
});

// Proxy: TN Horticulture print page → avoid X-Frame-Options block
app.get("/api/tn-print/:id", async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).send("Missing application id");

    const upstream = `https://tnhorticulture.tn.gov.in:8080/Print/PrintApplication/${encodeURIComponent(id)}`;

    const r = await tnFetch(upstream, {
      referer: `${TN_BASE}/Subsidy/TrackApplication`,
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
  created_by: string | null;
  started_at: string | null;
  finished_at: string | null;
  last_error: string | null;
};

async function createBulkJob(total: number, created_by?: string | null): Promise<string> {
  const { rows } = await pool.query(
    `INSERT INTO bulk_jobs (status, total, done, ok, error, created_by)
     VALUES ('queued', $1, 0, 0, 0, $2)
     RETURNING id::text`,
    [total, created_by ?? null]
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

async function insertBulkAppItems(jobId: string, appIds: string[]) {
  if (!appIds.length) return;
  const values: any[] = [];
  const tuples: string[] = [];
  let i = 0;
  for (const raw of appIds) {
    const val = String(raw ?? "").trim();
    if (!val) continue;
    // kind = 'application'; store the raw App ID verbatim
    values.push(jobId, val, "application", "pending", "");
    tuples.push(`($${i + 1},$${i + 2},$${i + 3},$${i + 4},$${i + 5})`);
    i += 5;
  }
  if (!tuples.length) return;
  await pool.query(
    `INSERT INTO bulk_job_items (job_id, number, kind, state, message)
     VALUES ${tuples.join(",")}`,
    values
  );
}

async function getBulkJob(jobId: string): Promise<BulkJobRow | null> {
  const { rows } = await pool.query(
    `SELECT id::text, status, total, done, ok, error,
            created_at::text, updated_at::text, created_by,
            started_at::text as started_at, finished_at::text as finished_at,
            last_error
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
    created_by: r.created_by ?? null,
    started_at: r.started_at ?? null,
    finished_at: r.finished_at ?? null,
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

// Purge artifacts (statuses, surveys, applications) that were created/affected by a given bulk job
// Conservative: we remove timelines (statuses) and per-app survey rows,
// and now also the application master rows once dependents are gone.
async function purgeJobArtifacts(jobId: string): Promise<{ appIds: string[]; deleted_statuses: number; deleted_surveys: number; deleted_applications: number }> {
  const client = await pool.connect();
  try {
    // 1) Collect impacted application_ids from job items
    const itemsQ = await client.query(
      `SELECT number, kind FROM public.bulk_job_items WHERE job_id = $1`,
      [jobId]
    );
    const items = itemsQ.rows || [];

    const appIds = new Set<string>();
    const mobiles: string[] = [];
    const aadhaars: string[] = [];

    for (const it of items) {
      const kind = String(it.kind || '').toLowerCase();
      const val = String(it.number || '').trim();
      if (!val) continue;
      if (kind === 'application') {
        appIds.add(val);
      } else if (kind === 'mobile') {
        mobiles.push(val);
      } else if (kind === 'aadhaar') {
        aadhaars.push(val);
      } else {
        // try to classify dynamically: 10-digit → mobile; 12-digit → aadhaar; else ignore
        const digits = val.replace(/\D/g, '');
        if (digits.length === 10) mobiles.push(digits);
        else if (digits.length === 12) aadhaars.push(digits);
      }
    }

    // 2) Expand appIds using numbers processed in this job
    if (mobiles.length) {
      const q = await client.query(
        `SELECT application_id FROM public.applications WHERE mobile = ANY($1::text[])`,
        [mobiles]
      );
      for (const r of q.rows) appIds.add(r.application_id);
    }
    if (aadhaars.length) {
      const q = await client.query(
        `SELECT application_id FROM public.applications WHERE aadhaar = ANY($1::text[])`,
        [aadhaars]
      );
      for (const r of q.rows) appIds.add(r.application_id);
    }

    const ids = Array.from(appIds);
    if (!ids.length) return { appIds: [], deleted_statuses: 0, deleted_surveys: 0, deleted_applications: 0 };

    // 3) Delete dependent rows
    let deletedStatuses = 0;
    let deletedSurveys = 0;
    // statuses
    const st = await client.query(
      `WITH del AS (
         DELETE FROM public.statuses WHERE application_id = ANY($1::text[])
         RETURNING 1
       ) SELECT count(*)::int AS n FROM del`,
      [ids]
    );
    deletedStatuses = Number(st.rows?.[0]?.n || 0);
    // application_surveys
    const sv = await client.query(
      `WITH del AS (
         DELETE FROM public.application_surveys WHERE application_id = ANY($1::text[])
         RETURNING 1
       ) SELECT count(*)::int AS n FROM del`,
      [ids]
    );
    deletedSurveys = Number(sv.rows?.[0]?.n || 0);

    // 4) Finally, delete application master rows now that dependents are gone
    let deletedApplications = 0;
    const ap = await client.query(
      `WITH del AS (
         DELETE FROM public.applications WHERE application_id = ANY($1::text[])
         RETURNING 1
       ) SELECT count(*)::int AS n FROM del`,
      [ids]
    );
    deletedApplications = Number(ap.rows?.[0]?.n || 0);

    return { appIds: ids, deleted_statuses: deletedStatuses, deleted_surveys: deletedSurveys, deleted_applications: deletedApplications };
  } finally {
    client.release();
  }
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
  // Before starting, check if job still exists and not canceled
  const activeBefore = await pool.query(`SELECT status FROM public.bulk_jobs WHERE id=$1`, [jobId]);
  if (!activeBefore.rowCount || String(activeBefore.rows[0].status).toLowerCase() === "canceled") {
    return; // abort early if already canceled/deleted
  }

  let anyError = false;
  try {
    const items = await getBulkItems(jobId, 100000); // all items for this job

    // Concurrency for local+TN processing (rate limiter in tnPost keeps TN at TN_MAX_PER_MIN)
    const WORKERS = Math.max(
      1,
      Math.min(
        BULK_CONCURRENCY,
        TN_MAX_PER_MIN
      )
    );

    let idx = 0;
    const runOne = async () => {
      const it = items[idx++];
      if (!it) return;

      // Check cancellation between items
      try {
        const q = await pool.query(`SELECT status FROM public.bulk_jobs WHERE id=$1`, [jobId]);
        if (!q.rowCount || String(q.rows[0].status).toLowerCase() === "canceled") {
          return; // stop processing further items
        }
      } catch {}

      try {
        const rawVal = String(it.number);
        if (String(it.kind) === "application") {
          await patchBulkItem(jobId, rawVal, "processing", "Fetching application details…");

          // 1) Print meta → gives district/block/village and may reveal mobile
          let mobileFromMeta: string | null = null;
          try {
            const meta = await fetchAndStorePrintMeta(rawVal);
            if (meta?.mobile) {
              const m = normalizePhoneE164(meta.mobile);
              if (m && m.length === 10) mobileFromMeta = m;
            }
          } catch {}

          // 2) Applications via discovered mobile (apps first) so they exist before statuses
          if (mobileFromMeta) {
            try {
              const cachedApps = await getApplicationsByNumber(mobileFromMeta);
              if (cachedApps.length) {
                for (const app of cachedApps) {
                  // ensure print meta and surveys for each app
                  try { await fetchAndStorePrintMeta((app as any).application_id); } catch {}
                  try { await replaceApplicationSurveys((app as any).application_id, (app as any).survey_no, (app as any).subdivision_no); } catch {}
                }
              } else {
                const mappedApps = await fetchAppsByNumberFromTN(mobileFromMeta);
                if (mappedApps.length) {
                  await upsertApplications(mappedApps as any);
                  for (const app of mappedApps) {
                    try { await fetchAndStorePrintMeta(app.application_id); } catch {}
                    try { await replaceApplicationSurveys(app.application_id, app.survey_no, app.subdivision_no); } catch {}
                  }
                }
              }
            } catch {}
          }

          // 3) Only after apps exist, fetch statuses for this Application ID
          let statuses: any[] = [];
          let gotFromCache = false;
          try {
            if (await hasStatuses(rawVal)) {
              statuses = await getStatuses(rawVal);
              gotFromCache = true;
            } else {
              statuses = await fetchAndStoreStatuses(rawVal);
              gotFromCache = false;
            }
          } catch { statuses = []; }

          const okMsg = (statuses && statuses.length)
            ? (gotFromCache ? "Already available locally" : "Fetched from government sources")
            : "No Data";
          await patchBulkItem(jobId, rawVal, "ok", okMsg);
          await bumpJobCounters(jobId, 1, 1, 0);
          return;
        }

        await patchBulkItem(jobId, rawVal, "processing", "Checking local cache…");

        const cls = classifyInputNumber(rawVal);
        if (cls.kind === "invalid" || !cls.normalized) {
          await patchBulkItem(jobId, rawVal, "error", "Invalid number format");
          await bumpJobCounters(jobId, 1, 0, 1);
          anyError = true;
          return;
        }

        const cached = await getApplicationsByNumber(cls.normalized);
        if (cached.length) {
          for (const app of cached) {
            if (!(app as any).has_statuses) {
              try { await fetchAndStoreStatuses((app as any).application_id); } catch {}
            }
            try { await fetchAndStorePrintMeta((app as any).application_id); } catch {}
          }
          await patchBulkItem(jobId, cls.normalized, "ok", "Already available locally");
          await bumpJobCounters(jobId, 1, 1, 0);
          return;
        }

        await patchBulkItem(jobId, cls.normalized, "processing", "Pulling from government sources…");

        const mapped = await fetchAppsByNumberFromTN(cls.normalized);
        if (mapped.length) {
          await upsertApplications(mapped as any);
          for (const app of mapped) {
            try { await fetchAndStoreStatuses(app.application_id); } catch {}
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
        await runOne();
      }
    };

    await Promise.all(Array.from({ length: Math.min(WORKERS, items.length) }, () => runOne()));
  } catch (e) {
    // If the loop throws before we finish, mark as error
    anyError = true;
    console.error("[bulk] processBulkJob fatal error:", (e as any)?.message || e);
  } finally {
    // Always set a terminal status so UI doesn't stay stuck at running
    await setJobStatus(jobId, anyError ? "error" : "done");
  }
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
             b.created_by,
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
      `select id::text, status, total, done, ok, error, created_at::text, updated_at::text, created_by
         from bulk_jobs
        order by created_at desc
        limit 1`
    );
    if (!rows.length) return res.json({ ok: true, job: null, jobId: null });
    const j = rows[0];
    return res.json({ ok: true, job: j, jobId: j.id });
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

    const created_by = String(req.body?.created_by || "").trim() || null;
    const jobId = await createBulkJob(nums.length, created_by);
    await insertBulkItems(jobId, nums);

    // async fire-and-forget
    processBulkJob(jobId).catch((e) => console.error("[bulk] processor error:", e));

    return res.json({ ok: true, jobId });
  } catch (e: any) {
    console.error("/api/bulk/start error:", e);
    return res.status(500).json({ ok: false, message: e?.message || "Failed to start bulk job" });
  }
});

// Start bulk job for Application IDs (persisted like numbers)
app.post("/api/bulk/start-appid", async (req: Request, res: Response) => {
  try {
    const raw = (req.body?.appids ?? req.body?.application_ids ?? req.body?.applicationIds ?? req.body?.ids);
    if (!Array.isArray(raw)) return res.status(400).json({ ok: false, message: "appids[] required (array of strings)" });

    const ids: string[] = raw.map((x: any) => String(x ?? "").trim()).filter(s => s.length > 0);
    if (!ids.length) return res.status(400).json({ ok: false, message: "No application IDs to process." });

    const created_by = String(req.body?.created_by || "").trim() || null;
    const jobId = await createBulkJob(ids.length, created_by);
    await insertBulkAppItems(jobId, ids);

    // async fire-and-forget
    processBulkJob(jobId).catch((e) => console.error("[bulk-appid] processor error:", e));

    return res.json({ ok: true, jobId });
  } catch (e: any) {
    console.error("/api/bulk/start-appid error:", e);
    return res.status(500).json({ ok: false, message: e?.message || "Failed to start bulk appid job" });
  }
});

// Job status (derived live from public.bulk_job_items)
app.get("/api/bulk/:id/status", async (req: Request, res: Response) => {
  res.set("Content-Type", "application/json");
  const jobId = String(req.params.id || "").trim();
  if (!jobId) return res.status(400).json({ ok: false, message: "Missing job id" });
  try {
    // Load job row
    const jobQ = await pool.query(
      `SELECT id::text, status, total, done, ok, error,
              created_at::text, updated_at::text, created_by
         FROM public.bulk_jobs
        WHERE id = $1`,
      [jobId]
    );
    if (jobQ.rowCount === 0) return res.status(404).json({ ok: false, message: "Job not found" });
    const job = jobQ.rows[0];

    // Load items directly (schema-agnostic) and normalize in JS
    let items: Array<{ number: string; kind: string; state: string; message: string; updated_at: any }>;
    try {
      const itemsQ = await pool.query(
        `SELECT *
           FROM public.bulk_job_items
          WHERE job_id = $1
          ORDER BY id ASC
          LIMIT 10000`,
        [jobId]
      );
      const raw = itemsQ.rows || [];
      items = raw.map((it: any) => ({
        number: String(it.number ?? it.input ?? it.value ?? it.raw ?? ""),
        kind: String((it.kind ?? it.item_kind ?? it.type ?? 'unknown')).toLowerCase(),
        state: String((it.state ?? it.status ?? it.result ?? 'pending')).toLowerCase(),
        message: String(it.message ?? it.detail ?? it.last_message ?? ''),
        updated_at: it.updated_at ?? it.created_at ?? null,
      }));
    } catch (e) {
      console.error('[bulk status] items fetch error', e);
      items = [];
    }

    // Derive counters from items (authoritative)
    const agg = items.reduce(
      (a: any, it: any) => {
        a.total++;
        const s = String(it.state || "").toLowerCase();
        if (s === "ok" || s === "success" || s === "completed") { a.ok++; a.done++; }
        else if (s === "error" || s === "failed" || s === "fail") { a.error++; a.done++; }
        return a;
      },
      { total: 0, ok: 0, error: 0, done: 0 }
    );

    // Prefer derived counters when job table is empty or behind; sync best-effort
    const derived = {
      total: Number(job.total || 0) > 0 ? Number(job.total) : agg.total,
      done: Math.max(Number(job.done || 0), agg.done),
      ok: Math.max(Number(job.ok || 0), agg.ok),
      error: Math.max(Number(job.error || 0), agg.error),
    };
    try {
      const needsSync = (
        (job.total ?? 0) !== derived.total ||
        (job.done  ?? 0) !== derived.done  ||
        (job.ok    ?? 0) !== derived.ok    ||
        (job.error ?? 0) !== derived.error
      );
      if (needsSync) {
        await pool.query(
          `UPDATE public.bulk_jobs
              SET total = $2, done = $3, ok = $4, error = $5, updated_at = now()
            WHERE id = $1`,
          [jobId, derived.total, derived.done, derived.ok, derived.error]
        );
        job.total = derived.total;
        job.done = derived.done;
        job.ok = derived.ok;
        job.error = derived.error;
      }
    } catch (_) { /* ignore sync errors */ }

    return res.json({
      ok: true,
      job: {
        id: job.id,
        status: job.status,
        total: Number(job.total || 0),
        done: Number(job.done || 0),
        ok: Number(job.ok || 0),
        error: Number(job.error || 0),
        created_at: job.created_at,
        updated_at: job.updated_at,
        created_by: job.created_by ?? null,
      },
      items: items.map((it: any) => ({
        number: it.number,
        kind: it.kind,
        state: it.state,
        message: it.message,
        updated_at: it.updated_at,
      })),
    });
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

// Delete a job (and optionally purge its artifacts)
app.delete('/api/bulk/:id', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, message: 'Missing job id' });
    const purge = String(req.query.purge || '') === '1' || String(req.query.purge || '') === 'true';

    let purgeInfo: any = null;
    if (purge) {
      try { purgeInfo = await purgeJobArtifacts(id); } catch (e: any) { purgeInfo = { error: e?.message || String(e) }; }
    }

    // Delete items, then the job
    await pool.query(`DELETE FROM public.bulk_job_items WHERE job_id = $1`, [id]);
    await pool.query(`DELETE FROM public.bulk_jobs WHERE id = $1`, [id]);

    return res.json({ ok: true, purged: Boolean(purge), purgeInfo, deleted_applications: purgeInfo?.deleted_applications ?? 0 });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message || 'Failed to delete job' });
  }
});

// Fallback variant used by UI: POST /api/bulk/:id/delete
app.post('/api/bulk/:id/delete', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, message: 'Missing job id' });
    const purge = (String(req.query.purge || '') === '1' || String(req.query.purge || '') === 'true') || Boolean(req.body?.purge);

    let purgeInfo: any = null;
    if (purge) {
      try { purgeInfo = await purgeJobArtifacts(id); } catch (e: any) { purgeInfo = { error: e?.message || String(e) }; }
    }

    await pool.query(`DELETE FROM public.bulk_job_items WHERE job_id = $1`, [id]);
    await pool.query(`DELETE FROM public.bulk_jobs WHERE id = $1`, [id]);

    return res.json({ ok: true, purged: Boolean(purge), purgeInfo, deleted_applications: purgeInfo?.deleted_applications ?? 0 });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message || 'Failed to delete job' });
  }
});

// Fallback variant used by UI: POST /api/bulk/delete { id, purge }
app.post('/api/bulk/delete', async (req: Request, res: Response) => {
  try {
    const id = String(req.body?.id || '').trim();
    if (!id) return res.status(400).json({ ok: false, message: 'Missing job id' });
    const purge = Boolean(req.body?.purge);

    let purgeInfo: any = null;
    if (purge) {
      try { purgeInfo = await purgeJobArtifacts(id); } catch (e: any) { purgeInfo = { error: e?.message || String(e) }; }
    }

    await pool.query(`DELETE FROM public.bulk_job_items WHERE job_id = $1`, [id]);
    await pool.query(`DELETE FROM public.bulk_jobs WHERE id = $1`, [id]);

    return res.json({ ok: true, purged: Boolean(purge), purgeInfo, deleted_applications: purgeInfo?.deleted_applications ?? 0 });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message || 'Failed to delete job' });
  }
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

// Cancel a job AND delete everything created by it (artifacts + job rows)
app.post("/api/bulk/:id/cancel", async (req: Request, res: Response) => {
  res.set("Content-Type", "application/json");
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).json({ ok: false, message: "Missing job id" });
  try {
    // 1) Mark job canceled (best-effort; may be deleted right after)
    try { await setJobStatus(id, "canceled"); } catch {}

    // 2) Purge artifacts created/affected by this job
    let purgeInfo: any = null;
    try { purgeInfo = await purgeJobArtifacts(id); } catch (e: any) { purgeInfo = { error: e?.message || String(e) }; }

    // 3) Delete job items and the job
    await pool.query(`DELETE FROM public.bulk_job_items WHERE job_id = $1`, [id]);
    await pool.query(`DELETE FROM public.bulk_jobs WHERE id = $1`, [id]);

    return res.json({ ok: true, canceled: true, purged: true, purgeInfo, deleted_applications: purgeInfo?.deleted_applications ?? 0 });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message || "Failed to cancel and delete job" });
  }
});

// Fallback: allow POST /api/bulk/cancel { id }
app.post("/api/bulk/cancel", async (req: Request, res: Response) => {
  res.set("Content-Type", "application/json");
  const id = String(req.body?.id || "").trim();
  if (!id) return res.status(400).json({ ok: false, message: "Missing job id" });
  try {
    try { await setJobStatus(id, "canceled"); } catch {}
    let purgeInfo: any = null;
    try { purgeInfo = await purgeJobArtifacts(id); } catch (e: any) { purgeInfo = { error: e?.message || String(e) }; }
    await pool.query(`DELETE FROM public.bulk_job_items WHERE job_id = $1`, [id]);
    await pool.query(`DELETE FROM public.bulk_jobs WHERE id = $1`, [id]);
    return res.json({ ok: true, canceled: true, purged: true, purgeInfo, deleted_applications: purgeInfo?.deleted_applications ?? 0 });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message || "Failed to cancel and delete job" });
  }
});

/* -------------------- start -------------------- */
// --- Ensure all /api errors return JSON (no HTML error pages) ---
app.use("/api", (err: any, req: Request, res: Response, next: any) => {
  try { res.set("Content-Type", "application/json"); } catch {}
  const code = Number(err?.status || err?.statusCode || 500) || 500;
  const msg = (err && err.message) ? err.message : "Internal error";
  return res.status(code).json({ ok: false, message: msg });
});

app.listen(PORT, () => {
  console.log(`Sri Lakshmi Agro OTP API listening on :${PORT} (registered users only: ${ALLOW_UNREGISTERED ? "no" : "yes"})`);
  // Kick off a prune shortly after boot, then hourly
  setTimeout(() => {
    pruneOldBulkJobs(BULK_RETENTION_DAYS).then(({ jobs, items }) => {
      if (jobs || items) console.log(`[prune] deleted ${jobs} jobs and ${items} items older than ${BULK_RETENTION_DAYS}d`);
    }).catch((e) => console.error('[prune] error on startup:', e?.message || e));
  }, 10_000);
  setInterval(() => {
    pruneOldBulkJobs(BULK_RETENTION_DAYS).then(({ jobs, items }) => {
      if (jobs || items) console.log(`[prune] deleted ${jobs} jobs and ${items} items older than ${BULK_RETENTION_DAYS}d`);
    }).catch((e) => console.error('[prune] interval error:', e?.message || e));
  }, 60 * 60 * 1000); // hourly
});

// ---- Fast statuses by application id (DB-first, no TN unless FE calls /api/search/application) ----
app.get("/api/statuses", async (req: Request, res: Response) => {
  try {
    const appId = String(req.query.appId || "").trim();
    if (!appId) return res.status(400).json({ ok: false, error: "appId required" });
    const rows = await getStatuses(appId);
    return res.json({ ok: true, statuses: rows });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || "Failed to load statuses" });
  }
});

app.post("/api/statuses/by-appid", async (req: Request, res: Response) => {
  try {
    const appId = String(req.body?.appId || "").trim();
    if (!appId) return res.status(400).json({ ok: false, error: "appId required" });
    const rows = await getStatuses(appId);
    return res.json({ ok: true, statuses: rows });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || "Failed to load statuses" });
  }
});