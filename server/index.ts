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
// Accept urlencoded form bodies (for FormData etc)
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// -------------------- postgres --------------------
const basePgCfg = (
  DATABASE_URL
    ? { connectionString: DATABASE_URL }
    : { host: PGHOST, port: PGPORT, database: PGDATABASE, user: PGUSER, password: PGPASSWORD }
) as any;

const pool = new Pool({
  ...basePgCfg,
  max: Math.max(10, Number(process.env.PGPOOL_MAX || 20)),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30_000),
  connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS || 10_000),
  keepAlive: true,
  keepAliveInitialDelayMillis: Number(process.env.PG_KEEPALIVE_DELAY_MS || 10_000),
  allowExitOnIdle: false,
});

// Prevent crashes on intermittent network errors with the DB
pool.on('error', (err: any) => {
  console.error('[pg] idle client error:', err?.message || err);
});

// Tiny retry helper for PG queries
async function pgQueryRetry<T = any>(text: string, params?: any[], attempts = 2): Promise<{ rows: T[]; rowCount: number }>{
  let lastErr: any;
  for (let i = 0; i < Math.max(1, attempts); i++) {
    try {
      const r = await pool.query(text, params as any);
      return { rows: r.rows as T[], rowCount: r.rowCount ?? (r.rows?.length || 0) };
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message || '').toLowerCase();
      const code = String(e?.code || '').toUpperCase();
      // Retry on common transient conditions
      const transient = msg.includes('timeout') || msg.includes('terminated') || code === 'ETIMEDOUT';
      if (!transient || i === attempts - 1) break;
      await new Promise(r => setTimeout(r, 300));
    }
  }
  throw lastErr;
}

async function tableExists(schema: string, table: string): Promise<boolean> {
  try {
    const q = await pool.query(
      `select 1 from information_schema.tables where table_schema = $1 and table_name = $2 limit 1`,
      [schema, table]
    );
    return q.rowCount === 1;
  } catch {
    return false;
  }
}

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

function normalizeMobile10Strict(x: string | null | undefined): string | null {
  const d = String(x || '').replace(/\D/g, '');
  if (d.length < 10) return null;
  return d.slice(-10);
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
function slugifyJobName(name: string): string {
  return name
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[^A-Za-z0-9._ -]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 120);
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

// --- Helpers to parse applied_date and compute 7-year eligibility ---
function parseAppliedDateToUTC(raw?: string | null): Date | null {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{2})-(\d{2})-(\d{4})$/); // DD-MM-YYYY
  if (m) return new Date(Date.UTC(+m[3], +m[2]-1, +m[1]));
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);      // YYYY-MM-DD
  if (m) return new Date(Date.UTC(+m[1], +m[2]-1, +m[3]));
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);  // DD/MM/YYYY
  if (m) return new Date(Date.UTC(+m[3], +m[2]-1, +m[1]));
  m = s.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);  // YYYY/MM/DD
  if (m) return new Date(Date.UTC(+m[1], +m[2]-1, +m[3]));
  const d = new Date(s);
  if (!isNaN(d.getTime())) return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  return null;
}

function computeSevenYearEligibility(appliedUTC: Date | null) {
  if (!appliedUTC) return { applied_dt: null as string | null, age_days: null as number | null, next_due: null as string | null, days_remaining: null as number | null, eligible: null as boolean | null };
  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const dayMs = 24 * 60 * 60 * 1000;
  const age_days = Math.floor((todayUTC.getTime() - appliedUTC.getTime()) / dayMs);
  const next_due = new Date(appliedUTC.getTime());
  next_due.setUTCFullYear(next_due.getUTCFullYear() + 7);
  const rem = Math.ceil((next_due.getTime() - todayUTC.getTime()) / dayMs);
  const days_remaining = Math.max(0, rem);
  const eligible = days_remaining === 0;
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  return { applied_dt: fmt(appliedUTC), age_days, next_due: fmt(next_due), days_remaining, eligible };
}

// --- Utility to enrich application rows with eligibility and surveys ---
async function enrichApplicationsWithEligibility(apps: (AppRow & { has_statuses?: boolean })[]) {
  if (!Array.isArray(apps) || !apps.length) return apps;
  const ids = apps.map(a => a.application_id);
  const svyMap = new Map<string, { survey_no: string | null, subdivision_no: string | null }[]>();
  try {
    const { rows } = await pool.query(
      `select application_id, survey_no, subdivision_no from public.application_surveys where application_id = any($1)`,
      [ids]
    );
    for (const r of rows as any[]) {
      const arr = svyMap.get(r.application_id) || [];
      arr.push({ survey_no: r.survey_no ?? null, subdivision_no: r.subdivision_no ?? null });
      svyMap.set(r.application_id, arr);
    }
  } catch {}

  return apps.map(a => {
    const appliedUTC = parseAppliedDateToUTC(a.applied_date);
    const elig = computeSevenYearEligibility(appliedUTC);
    const surveys = (svyMap.get(a.application_id) || []).map(s => ({
      survey_no: s.survey_no,
      subdivision_no: s.subdivision_no,
      completed_on: elig.applied_dt,
      next_due: elig.next_due,
      days_remaining: elig.days_remaining,
      eligible: elig.eligible,
    }));
    return { ...a, eligibility: elig, surveys } as any;
  });
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
    if (DEBUG_TN) {
      console.warn('[tnPost] payload was:', JSON.stringify(payload));
    }
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

// --- Shared completeness helper for app rows ---
const REQUIRED_FIELDS_KEYS: Array<keyof AppRow> = [
  'crop_type', 'mi_name', 'applied_date', 'farmer_name', 'mi_area', 'total_area',
  'survey_no', 'subdivision_no', 'farmer_type', 'ss'
];
function isAppComplete(a: Partial<AppRow> | AppRow | null | undefined): boolean {
  if (!a) return false;
  return REQUIRED_FIELDS_KEYS.every(k => (a as any)[k] != null && String((a as any)[k]).trim() !== '');
}

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
        mobile  = COALESCE(NULLIF(applications.mobile,  ''), EXCLUDED.mobile),
        aadhaar = COALESCE(NULLIF(applications.aadhaar,''), EXCLUDED.aadhaar),
        district = COALESCE(NULLIF(applications.district,''), EXCLUDED.district),
        block    = COALESCE(NULLIF(applications.block,  ''), EXCLUDED.block),
        village  = COALESCE(NULLIF(applications.village,''), EXCLUDED.village),
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

// --- granular application_surveys upsert (handles nested survey arrays) ---
function _svy_s(x: any): string | null {
  if (x == null) return null;
  const v = String(x).trim();
  return v ? v : null;
}

// Discover once whether application_surveys has geo columns
let _SURVEY_HAS_GEO: boolean | null = null;
async function ensureSurveySchema(): Promise<boolean> {
  if (_SURVEY_HAS_GEO !== null) return _SURVEY_HAS_GEO;
  try {
    const q = await pool.query(
      `select 1 from information_schema.columns
        where table_schema = 'public' and table_name = 'application_surveys'
          and column_name in ('district','block','village')
        limit 1`
    );
    _SURVEY_HAS_GEO = !!q.rowCount;
  } catch {
    _SURVEY_HAS_GEO = false;
  }
  return _SURVEY_HAS_GEO;
}

async function upsertApplicationSurvey(
  appId: string,
  surveyNo: string | null,
  subDivNo: string | null,
  district?: string | null,
  block?: string | null,
  village?: string | null
) {
  if (!appId) return;
  const hasGeo = await ensureSurveySchema();
  if (hasGeo) {
    await pool.query(
      `insert into public.application_surveys (application_id, survey_no, subdivision_no, district, block, village)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (application_id, survey_no, subdivision_no) do update set
         district = excluded.district,
         block    = excluded.block,
         village  = excluded.village`,
      [appId, _svy_s(surveyNo), _svy_s(subDivNo), _svy_s(district), _svy_s(block), _svy_s(village)]
    );
  } else {
    // Legacy 3-column table – ignore geo silently
    await pool.query(
      `insert into public.application_surveys (application_id, survey_no, subdivision_no)
       values ($1,$2,$3)
       on conflict (application_id, survey_no, subdivision_no) do nothing`,
      [appId, _svy_s(surveyNo), _svy_s(subDivNo)]
    );
  }
}

function extractSurveyTuplesFromApp(app: any) {
  const appId   = _svy_s(app?.application_id || app?.appId || app?.applicationId || app?.id);
  if (!appId) return [] as any[];
  const district = _svy_s(app?.district || app?.dist || app?.district_name || app?.districtName);
  const block    = _svy_s(app?.block || app?.block_name || app?.blockName || app?.taluk);
  const village  = _svy_s(app?.village || app?.village_name || app?.villageName);
  const surveyNo = _svy_s(app?.survey_no || app?.survey || app?.survey_number);
  const subDivNo = _svy_s(app?.subdivision_no || app?.sub_division_no || app?.subdivision || app?.sub_div_no);

  const tuples: { appId: string, survey_no: string | null, subdivision_no: string | null, district: string | null, block: string | null, village: string | null }[] = [];
  const lists: any[] = [];
  if (Array.isArray(app?.surveys)) lists.push(...app.surveys);
  if (Array.isArray(app?.survey_list)) lists.push(...app.survey_list);
  if (Array.isArray(app?.application_surveys)) lists.push(...app.application_surveys);

  if (lists.length) {
    for (const s of lists) {
      const sNo  = _svy_s(s?.survey_no || s?.survey || s?.survey_number) || surveyNo;
      const sdNo = _svy_s(s?.subdivision_no || s?.sub_division_no || s?.subdivision) || subDivNo;
      tuples.push({ appId, survey_no: sNo || null, subdivision_no: sdNo || null, district, block, village });
    }
  } else {
    tuples.push({ appId, survey_no: surveyNo, subdivision_no: subDivNo, district, block, village });
  }
  return tuples;
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
     WHERE ${
       isAadhaar
         ? "RIGHT(regexp_replace(COALESCE(a.aadhaar,''), '[^0-9]', '', 'g'), 12) = $1"
         : "RIGHT(regexp_replace(COALESCE(a.mobile,''),  '[^0-9]', '', 'g'), 10) = $1"
     }
     ORDER BY a.updated_at DESC
  `;
  const { rows } = await pool.query(sql, [number]);
  return rows as (AppRow & { has_statuses: boolean })[];
}

// Helper: fetch applications by number WITHIN days window based on applied_date
async function getApplicationsByNumberWithinDays(number: string, days: number) {
  const isAadhaar = number.length === 12;
  const sql = `
    WITH base AS (
      SELECT 
        a.application_id, a.crop_type, a.mi_name, a.applied_date, a.farmer_name,
        a.mi_area, a.total_area, a.survey_no, a.subdivision_no, a.farmer_type, a.ss,
        a.mobile, a.aadhaar, a.district, a.block, a.village,
        CASE 
          WHEN a.applied_date ~ '^[0-9]{2}-[0-9]{2}-[0-9]{4}$' THEN to_date(a.applied_date,'DD-MM-YYYY')
          WHEN a.applied_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN to_date(a.applied_date,'YYYY-MM-DD')
          WHEN a.applied_date ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$' THEN to_date(a.applied_date,'DD/MM/YYYY')
          WHEN a.applied_date ~ '^[0-9]{4}/[0-9]{2}/[0-9]{2}$' THEN to_date(a.applied_date,'YYYY/MM/DD')
          ELSE NULL
        END AS applied_dt
      FROM applications a
      WHERE ${
        isAadhaar
          ? "RIGHT(regexp_replace(COALESCE(a.aadhaar,''), '[^0-9]', '', 'g'), 12) = $1"
          : "RIGHT(regexp_replace(COALESCE(a.mobile,''),  '[^0-9]', '', 'g'), 10) = $1"
      }
    )
    SELECT 
      b.application_id, b.crop_type, b.mi_name, b.applied_date, b.farmer_name,
      b.mi_area, b.total_area, b.survey_no, b.subdivision_no, b.farmer_type, b.ss,
      b.mobile, b.aadhaar, b.district, b.block, b.village,
      EXISTS (SELECT 1 FROM statuses s WHERE s.application_id = b.application_id) AS has_statuses
    FROM base b
    WHERE b.applied_dt IS NOT NULL AND (current_date - b.applied_dt)::int BETWEEN 0 AND $2
    ORDER BY b.applied_dt DESC NULLS LAST, b.application_id DESC
  `;
  const { rows } = await pool.query(sql, [number, days]);
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
    "/HttpServiceLogin/get_search_application_status_by_aadhar"
  ];

  let rows: any[] = [];
  for (const path of candidates) {
    const inner = await tnPost(path, payload, referer);
    const table = Array.isArray((inner as any)?.Table) ? (inner as any).Table : [];
    if (DEBUG_TN) console.log(`[fetchAppsByNumberFromTN] tried ${path} -> ${table.length} rows`);
    if (table.length) { rows = table; break; }
  }

  if (!rows.length) return [];

  const mapped = rows.map((t: any) => {
    const BLANKS = new Set(["", " ", "null", "NULL", "na", "NA", "n/a", "N/A", "-", "--"]);
    const clean = (v: any): any => {
      if (v == null) return null;
      const s = String(v).trim();
      if (BLANKS.has(s)) return null;
      return s;
    };
    const get = (v: any, ...alts: any[]) => {
      const first = clean(v);
      if (first != null) return first;
      for (const a of alts) {
        const c = clean(a);
        if (c != null) return c;
      }
      return null;
    };
    const toNum = (x: any) => {
      const s = clean(x);
      if (s == null) return null;
      const n = Number(String(s).replace(/,/g, ""));
      return Number.isFinite(n) ? n : null;
    };

    const application_id = String(get(t.application_id, t.appId, t.id) ?? "").trim();
    const crop_type      = get(t.crop_type, t.crop_name, t.cropType);
    const mi_name        = get(t.mi_name, t.company_name, t.miName);
    const applied_date   = get(t.applied_date, t.appliedDate);
    const farmer_name    = get(t.farmer_name, t.applicant_name, t.applicantName, t.farmer);
    const mi_area_raw    = get(t.mi_area, t.mi_hectare, t.mi, t.miarea);
    const total_area_raw = get(t.total_area, t.total_hectare, t.hectare, t.area);
    const survey_no      = get(t.survey_no, t.survey, t.survey_number);
    const subdivision_no = get(t.subdivision_no, t.sub_division_no, t.subdivision);
    const farmer_type    = get(t.farmer_type, t.farmerType);
    const ss             = get(t.ss, t.status_summary, t.latest_status);

    return {
      application_id,
      crop_type:    crop_type ?? null,
      mi_name:      mi_name ?? null,
      applied_date: applied_date ?? null,
      farmer_name:  farmer_name ?? null,
      mi_area:      toNum(mi_area_raw),
      total_area:   toNum(total_area_raw),
      survey_no:    survey_no ?? null,
      subdivision_no: subdivision_no ?? null,
      farmer_type:  farmer_type ?? null,
      ss:           ss ?? null,
      source: "number",
      mobile:  isAadhaar ? null   : number,
      aadhaar: isAadhaar ? number : null,
      district: null,
      block: null,
      village: null,
    } as AppRow & { source: string };
  });

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

  // PRIMARY (as requested): exact endpoint
  const primary = "/HttpServiceLogin/get_search_application_status";
  const referer = "/Subsidy/TrackApplication";
  const basePayload = { xformVars: [{ name: "txtSearchAppId", value: appId }, { name: "StatusType", value: "1" }] };

  // Fallbacks kept for resilience
  const fallbacks = [
    { path: "/HttpServiceLogin/get_search_application_status", payload: { xformVars: [{ name: "txtSearchAppId", value: appId }] } },
    { path: "/HttpServiceLogin/get_search_application_status_by_appid", payload: basePayload },
    { path: "/HttpServiceLogin/get_search_application_status_by_applicationid", payload: basePayload },
    { path: "/HttpServiceLogin/get_application_status_by_appid", payload: basePayload },
  ];

  // small retry helper
  const tryOnce = async (path: string, payload: any) => {
    // first attempt
    let inner = await tnPost(path, payload, referer);
    let table = Array.isArray((inner as any)?.Table) ? (inner as any).Table : [];
    if (table.length) return table;
    // quick retry (handles transient 5xx)
    await new Promise(r => setTimeout(r, 400));
    inner = await tnPost(path, payload, referer);
    table = Array.isArray((inner as any)?.Table) ? (inner as any).Table : [];
    return table;
  };

  let table: any[] = [];
  // Primary first
  table = await tryOnce(primary, basePayload);

  // Fallbacks only if needed
  if (!table.length) {
    for (const fb of fallbacks) {
      table = await tryOnce(fb.path, fb.payload);
      if (DEBUG_TN) console.log(`[fetchAndStoreStatuses] tried ${fb.path} -> ${table.length} rows`);
      if (table.length) break;
    }
  }

  if (table.length) {
    items = table.map((r: any) => ({
      status_date: parseStatusDateToISO(r.status_date) ?? null,
      status: r.status,
      remarks: r.remarks,
      components: r.components,
      name: r.name,
    }));
  } else {
    items = [];
  }

  // Only persist when we actually have timeline rows from TN
  if (items.length > 0) {
    await upsertApplications([
      { application_id: appId, source: "application", ss: items?.[0]?.status ?? null, mobile: null, aadhaar: null } as any,
    ]);
    await replaceStatuses(appId, items);
  } else {
    // No data from TN → do not create placeholder application rows
    if (DEBUG_TN) console.log(`[fetchAndStoreStatuses] no rows for ${appId} — skipping persistence`);
  }

  return items;
}

// Global helper: check if a column exists on a table (schema.table or table)
async function pgColumnExists(tbl: string, col: string): Promise<boolean> {
  try {
    const schema = tbl.includes('.') ? tbl.split('.')[0] : 'public';
    const table  = tbl.includes('.') ? tbl.split('.')[1] : tbl;
    const q = await pool.query(
      `select 1 from information_schema.columns where table_schema = $1 and table_name = $2 and column_name = $3 limit 1`,
      [schema, table, col]
    );
    return q.rowCount === 1;
  } catch {
    return false;
  }
}


// Build a timeframe predicate using whichever timestamp columns exist on the table
async function buildDateWindowPredicate(table: string, alias: string, days: number, prefix: 'WHERE'|'AND'): Promise<string> {
  const candidates: string[] = ['updated_at','created_at','inserted_at','ts'];
  const present: string[] = [];
  for (const c of candidates) {
    if (await pgColumnExists(table, c)) present.push(`${alias}.${c}`);
  }
  if (!present.length) return '';
  if (present.length === 1) {
    return `${prefix} ${present[0]} >= now() - interval '${days} days'`;
  }
  // Use COALESCE over existing columns for robust gating
  return `${prefix} coalesce(${present.join(', ')}) >= now() - interval '${days} days'`;
}

/* -------------------- routes -------------------- */

app.get("/health", (_req: Request, res: Response) => res.json({ ok: true }));

// ---- Dashboard Overview (aggregated metrics for UI) ----
app.get("/api/dashboard/overview", async (_req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");

    // 1) Scalar metrics
    const scalarsSql = `
      with
      farmers as (
        select count(distinct right(regexp_replace(coalesce(mobile,''), '[^0-9]', '', 'g'), 10)) as n
        from public.applications
        where coalesce(mobile,'') <> ''
      ),
      apps as (
        select count(*) as n from public.applications
      ),
      d as (
        select count(distinct district) as n from public.applications where district is not null and district <> ''
      ),
      b as (
        select count(distinct block) as n from public.applications where block is not null and block <> ''
      ),
      v as (
        select count(distinct village) as n from public.applications where village is not null and village <> ''
      ),
      with_statuses as (
        select count(distinct application_id) as n from public.statuses
      ),
      jobs_run as (
        select count(*) as n from public.bulk_jobs where lower(status) = 'running'
      ),
      jobs_q as (
        select count(*) as n from public.bulk_jobs where lower(status) = 'queued'
      )
      select
        (select n from farmers)        as farmers,
        (select n from apps)           as applications,
        (select n from d)              as districts,
        (select n from b)              as blocks,
        (select n from v)              as villages,
        (select n from with_statuses)  as with_statuses,
        (select n from jobs_run)       as jobs_running,
        (select n from jobs_q)         as jobs_queued
    `;

    const scal = await pool.query(scalarsSql);
    const S = scal.rows?.[0] || {};

    // Compute last_sync safely without assuming created_at/updated_at exist
    async function getMaxTsSafe(table: string, cols: string[]): Promise<Date | null> {
      for (const c of cols) {
        try {
          const q = await pool.query(`select max(${c}) as ts from ${table}`);
          const v = q.rows?.[0]?.ts;
          if (v) return new Date(v);
        } catch (_) { /* column may not exist – try next */ }
      }
      return null;
    }
    const appTs = await getMaxTsSafe('public.applications', ['updated_at','created_at','ts','inserted_at']);
    const stTs  = await getMaxTsSafe('public.statuses',    ['updated_at','created_at','ts','inserted_at']);
    const lastSync = appTs && stTs ? (appTs > stTs ? appTs : stTs) : (appTs || stTs);

    // 2) Top geo lists (number of distinct applications per geography)
    const topDistrictsSql = `
      select a.district as name, count(distinct a.application_id)::int as count
      from public.applications a
      where a.district is not null and a.district <> ''
      group by a.district
      order by count desc nulls last, name asc`;

    const topBlocksSql = `
      select a.block as name, count(distinct a.application_id)::int as count
      from public.applications a
      where a.block is not null and a.block <> ''
      group by a.block
      order by count desc nulls last, name asc`;

    const topVillagesSql = `
      select a.village as name, count(distinct a.application_id)::int as count
      from public.applications a
      where a.village is not null and a.village <> ''
      group by a.village
      order by count desc nulls last, name asc`;

    const [dRows, bRows, vRows] = await Promise.all([
      pool.query(topDistrictsSql),
      pool.query(topBlocksSql),
      pool.query(topVillagesSql),
    ]);

    return res.json({
      ok: true,
      farmers: Number(S.farmers || 0),
      applications: Number(S.applications || 0),
      districts: Number(S.districts || 0),
      blocks: Number(S.blocks || 0),
      villages: Number(S.villages || 0),
      with_statuses: Number(S.with_statuses || 0),
      jobs_running: Number(S.jobs_running || 0),
      jobs_queued: Number(S.jobs_queued || 0),
      last_sync: lastSync ? lastSync.toISOString() : null,
      top_districts: (dRows.rows || []).map(r => ({ name: r.name, count: Number(r.count || 0) })),
      top_blocks:    (bRows.rows || []).map(r => ({ name: r.name, count: Number(r.count || 0) })),
      top_villages:  (vRows.rows || []).map(r => ({ name: r.name, count: Number(r.count || 0) })),
    });
  } catch (e: any) {
    console.error("/api/dashboard/overview error:", e?.message || e);
    return res.status(500).json({ ok: false, message: e?.message || "Failed to load overview" });
  }
});

// ---- Dashboard Fraud: same customer across multiple geographies ----
app.get("/api/dashboard/fraud", async (_req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");

    const sql = `
      with base as (
        select
          a.application_id,
          right(regexp_replace(coalesce(a.mobile, ''),  '[^0-9]', '', 'g'), 10) as m10,
          right(regexp_replace(coalesce(a.aadhaar, ''), '[^0-9]', '', 'g'), 12) as a12,
          a.district, a.block, a.village
        from public.applications a
      ),
      keyed as (
        select
          application_id,
          nullif(m10, '') as m10,
          nullif(a12, '') as a12,
          district, block, village,
          coalesce(nullif(m10, ''), concat('aad:', nullif(a12, ''))) as ck
        from base
        where (nullif(m10, '') is not null) or (nullif(a12, '') is not null)
      ),
      agg as (
        select
          ck,
          count(distinct application_id)                                 as applications,
          array_agg(distinct application_id)                             as application_ids,
          array_remove(array_agg(distinct coalesce(district, '')), '')   as districts,
          array_remove(array_agg(distinct coalesce(block, '')), '')      as blocks,
          array_remove(array_agg(distinct coalesce(village, '')), '')    as villages,
          max(m10)                                                       as mobile,
          max(a12)                                                       as aadhaar
        from keyed
        group by ck
      )
      select
        ck as customer_key,
        mobile,
        aadhaar,
        applications::int,
        application_ids,
        districts,
        blocks,
        villages
      from agg
      where cardinality(districts) > 1
         or cardinality(blocks)    > 1
         or cardinality(villages)  > 1
      order by applications desc, mobile nulls last, aadhaar nulls last;
    `;

    const { rows } = await pool.query(sql);
    return res.json({ ok: true, rows });
  } catch (e: any) {
    console.error("/api/dashboard/fraud error:", e?.message || e);
    return res.status(500).json({ ok: false, message: e?.message || "Failed to load fraud data" });
  }
});

// ---- Dashboard Leads (safe alias) ----
// Some clients call /api/dashboard/leads without the sub-path; delegate to /by-geo and never 404
app.get("/api/dashboard/leads", (req: Request, res: Response) => {
  // Preserve original query string when delegating to /by-geo
  const urlStr = String(req.url || "");
  const qIndex = urlStr.indexOf("?");
  const search = qIndex >= 0 ? urlStr.slice(qIndex) : "";
  const fwdUrl = "/api/dashboard/leads/by-geo" + search;

  // Create a proxy request that inherits from the original, but with a new URL
  const proxyReq: any = Object.create(req);
  proxyReq.url = fwdUrl;
  proxyReq.method = "GET";

  (app as any)._router.handle(proxyReq, res, () => {
    // Fallback: return empty payload instead of 404/500 (keeps caller happy)
    try {
      const level = String((req.query as any)?.level || 'district').toLowerCase();
      return res.json({ ok: true, level, rows: [] });
    } catch {
      return res.json({ ok: true, level: 'district', rows: [] });
    }
  });
});
// ---- Dashboard Leads (Geo Aggregation): potential leads across geographies ----
app.get("/api/dashboard/leads/by-geo", async (req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    const q: any = req.query || {};
    const level = String(q.level || 'district').toLowerCase();
    if (!['district','block','village'].includes(level)) {
      return res.status(400).json({ ok: false, message: "level must be one of district|block|village" });
    }

    const district = String(q.district || '').trim();
    const block    = String(q.block || '').trim();
    const village  = String(q.village || '').trim();

    const geoConds: string[] = [];
    const params: any[] = [];
    if (district) { params.push(district); geoConds.push(`a.district = $${params.length}`); }
    if (block)    { params.push(block);    geoConds.push(`a.block = $${params.length}`); }
    if (village)  { params.push(village);  geoConds.push(`a.village = $${params.length}`); }
    const geoSql = geoConds.length ? ` AND ${geoConds.join(' AND ')}` : '';

    // Optional: filter by 7-year eligibility within N days
    const dnum = Number((q as any).days);
    const daysFilter: number | null = Number.isFinite(dnum) && dnum >= 0 ? Math.floor(dnum) : null;
    if (daysFilter !== null) res.setHeader("x-sla-days", String(daysFilter));

    const sql = `
      with app_base as (
        select 
          a.application_id,
          right(regexp_replace(coalesce(a.mobile,''),'[^0-9]','','g'),10) as m10,
          trim(a.${level}) as geo,
          a.total_area,
          a.mi_area,
          case 
            when a.applied_date ~ '^[0-9]{2}-[0-9]{2}-[0-9]{4}$' then to_date(a.applied_date,'DD-MM-YYYY')
            when a.applied_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then to_date(a.applied_date,'YYYY-MM-DD')
            when a.applied_date ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$' then to_date(a.applied_date,'DD/MM/YYYY')
            when a.applied_date ~ '^[0-9]{4}/[0-9]{2}/[0-9]{2}$' then to_date(a.applied_date,'YYYY/MM/DD')
            else null
          end as applied_dt
        from public.applications a
        where 1=1
        ${geoSql}
      ), elig as (
        select *, case when applied_dt is null then null else greatest(0, ((applied_dt + interval '7 years')::date - current_date)) end as days_remaining
        from app_base
      ), filtered as (
        select * from ${daysFilter !== null ? 'elig' : 'app_base'}
        ${daysFilter !== null ? 'where applied_dt is null or days_remaining = 0 or days_remaining <= $DAYS$' : ''}
      ), mob as (
        select geo, count(distinct m10)::int as mobiles
        from filtered
        where m10 ~ '^[6-9][0-9]{9}$'
        group by geo
      )
      select 
        coalesce(f.geo,'') as name,
        count(distinct f.application_id)::int as applications,
        coalesce(m.mobiles,0)::int as mobiles,
        sum(coalesce(f.total_area,0))::float as total_area,
        sum(coalesce(f.mi_area,0))::float as mi_area
      from filtered f
      left join mob m on m.geo = f.geo
      group by f.geo, m.mobiles
      order by applications desc nulls last, name asc
    `;

    let finalSql = sql;
    const finalParams: any[] = [...params];
    if (daysFilter !== null) {
      const idx = finalParams.length + 1;
      // Replace ALL $DAYS$ occurrences globally
      finalSql = finalSql.replace(/\$DAYS\$/g, `$${idx}`);
      finalParams.push(daysFilter);
    } else {
      // Replace ALL $DAYS$ occurrences globally with 0 (safe default)
      finalSql = finalSql.replace(/\$DAYS\$/g, `0`);
    }
    const { rows } = await pool.query(finalSql, finalParams);
    return res.json({ ok: true, level, rows, ...(daysFilter !== null ? { days: daysFilter } : {}) });
  } catch (e: any) {
    console.error('/api/dashboard/leads/by-geo error:', e?.message || e);
    return res.status(500).json({ ok: false, message: e?.message || 'Failed to load leads geo' });
  }
});

// ---- Dashboard Leads (Geo Drilldown): list mobiles + hectares in a given geo ----
app.get("/api/dashboard/leads/list", async (req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    const q: any = req.query || {};
    const level = String(q.level || 'district').toLowerCase();
    const name  = String(q.name || '').trim();
    if (!['district','block','village'].includes(level)) {
      return res.status(400).json({ ok: false, message: "level must be one of district|block|village" });
    }
    if (!name) return res.json({ ok: true, level, name: '', rows: [] });

    const district = String(q.district || '').trim();
    const block    = String(q.block || '').trim();
    const village  = String(q.village || '').trim();

    const params: any[] = [name];
    const extraConds: string[] = [];
    if (level !== 'district' && district) { params.push(district); extraConds.push(`a.district = $${params.length}`); }
    if (level !== 'block'    && block)    { params.push(block);    extraConds.push(`a.block = $${params.length}`); }
    if (level !== 'village'  && village)  { params.push(village);  extraConds.push(`a.village = $${params.length}`); }
    const extraSql = extraConds.length ? ` AND ${extraConds.join(' AND ')}` : '';

    // Optional days filter for 7-year eligibility (read from query or Referer)
    let daysFilter: number | null = null;
    {
      const dFromQ = Number((q as any).days);
      if (Number.isFinite(dFromQ) && dFromQ >= 0) daysFilter = Math.floor(dFromQ);
      if (daysFilter == null) {
        const ref = String((req.headers as any)?.referer || (req.headers as any)?.referrer || '');
        const m = ref.match(/[?&]days=(\d+)/);
        if (m) {
          const n = Number(m[1]);
          if (Number.isFinite(n) && n >= 0) daysFilter = Math.floor(n);
        }
      }
      if (daysFilter !== null) res.setHeader('x-sla-days', String(daysFilter));
    }

    const sql = `
      with app_base as (
        select 
          a.application_id,
          right(regexp_replace(coalesce(a.mobile,''),'[^0-9]','','g'),10) as mobile,
          trim(a.${level}) as geo,
          a.total_area,
          a.mi_area,
          a.farmer_name,
          case 
            when a.applied_date ~ '^[0-9]{2}-[0-9]{2}-[0-9]{4}$' then to_date(a.applied_date,'DD-MM-YYYY')
            when a.applied_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then to_date(a.applied_date,'YYYY-MM-DD')
            when a.applied_date ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$' then to_date(a.applied_date,'DD/MM/YYYY')
            when a.applied_date ~ '^[0-9]{4}/[0-9]{2}/[0-9]{2}$' then to_date(a.applied_date,'YYYY/MM/DD')
            else null
          end as applied_dt
        from public.applications a
        where lower(trim(a.${level})) = lower(trim($1))
        ${extraSql}
      ), elig as (
        select *,
               case when applied_dt is null then null else (current_date - applied_dt)::int end as age_days,
               case when applied_dt is null then null else greatest(0, ((applied_dt + interval '7 years')::date - current_date)) end as days_remaining
        from app_base
      ), filtered as (
        select * from ${daysFilter !== null ? 'elig' : 'app_base'}
        ${daysFilter !== null ? 'where (applied_dt is null or days_remaining = 0 or days_remaining <= $DAYS$)' : ''}
      ), per_bucket as (
        -- Derive a bucket key: valid 10-digit mobile as-is; otherwise one row per application without mobile
        select 
          case when mobile ~ '^[6-9][0-9]{9}$' then mobile else concat('no-mobile:', application_id) end as bucket,
          mobile,
          application_id,
          total_area,
          mi_area,
          farmer_name,
          age_days,
          days_remaining,
          case when applied_dt is null or days_remaining = 0 or (days_remaining is not null and days_remaining <= $DAYS$) then true else false end as is_eligible
        from filtered
      ), agg as (
        -- Aggregate by bucket. For valid mobiles we collapse to one row; for no-mobile we keep one row per app.
        select 
          max(case when bucket like 'no-mobile:%' then null else bucket end) as mobile,
          count(distinct application_id)::int as applications,
          sum(coalesce(total_area,0))::float as total_area,
          sum(coalesce(mi_area,0))::float as mi_area,
          array_remove(array_agg(distinct coalesce(farmer_name,'')), '') as farmer_names,
          array_agg(distinct application_id) as application_ids,
          ${daysFilter !== null ? `array_agg(age_days order by application_id) as application_age_days,
          array_agg(days_remaining order by application_id) as application_days_remaining` : `array[]::int[] as application_age_days,
          array[]::int[] as application_days_remaining`},
          bool_or(is_eligible) as eligible_any
        from per_bucket
        group by bucket
      )
      select * from agg
      order by applications desc, total_area desc, coalesce(mobile, '') asc
    `;

    let finalSql = sql;
    const finalParams: any[] = [...params];
    if (daysFilter !== null) {
      const idx = finalParams.length + 1;
      // Replace ALL $DAYS$ occurrences globally
      finalSql = finalSql.replace(/\$DAYS\$/g, `$${idx}`);
      finalParams.push(daysFilter);
    } else {
      // Replace ALL $DAYS$ occurrences globally with 0 (safe default)
      finalSql = finalSql.replace(/\$DAYS\$/g, `0`);
    }
    const { rows } = await pool.query(finalSql, finalParams);
    return res.json({ ok: true, level, name, rows, ...(daysFilter !== null ? { days: daysFilter } : {}) });
  } catch (e: any) {
    console.error('/api/dashboard/leads/list error:', e?.message || e);
    return res.status(500).json({ ok: false, message: e?.message || 'Failed to load leads list' });
  }
});

// ---- Dashboard Leads (Filters): lists for District / Block / Village within timeframe ----
app.get("/api/dashboard/leads/filters", async (req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    const q: any = req.query || {};
    const dnum = Number(q.days);
    const days: number | null = Number.isFinite(dnum) && dnum >= 0 ? Math.floor(dnum) : null;
    const district = String(q.district || '').trim();
    const block    = String(q.block || '').trim();

    const base = `with raw as (
      select a.district, a.block, a.village,
        case 
          when a.applied_date ~ '^[0-9]{2}-[0-9]{2}-[0-9]{4}$' then to_date(a.applied_date,'DD-MM-YYYY')
          when a.applied_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then to_date(a.applied_date,'YYYY-MM-DD')
          when a.applied_date ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}$' then to_date(a.applied_date,'DD/MM/YYYY')
          when a.applied_date ~ '^[0-9]{4}/[0-9]{2}/[0-9]{2}$' then to_date(a.applied_date,'YYYY/MM/DD')
          else null
        end as applied_dt
      from public.applications a
    ), elig as (
      select *, case when applied_dt is null then null else greatest(0, ((applied_dt + interval '7 years')::date - current_date)) end as days_remaining from raw
    ), base as (
      select * from ${days !== null ? 'elig' : 'raw'}
      ${days !== null ? 'where applied_dt is null or days_remaining <= $DAYS$' : ''}
    )`;

    // Districts
    let sqlD = `${base}
      select b.district as name, count(*)::int as count
      from base b
      where b.district is not null and b.district <> ''
        ${block ? 'and b.block = $2' : ''}
      group by b.district
      order by name asc`;
    // Blocks
    let sqlB = `${base}
      select b.block as name, count(*)::int as count
      from base b
      where b.block is not null and b.block <> ''
        ${district ? 'and b.district = $2' : ''}
      group by b.block
      order by name asc`;
    // Villages
    let sqlV = `${base}
      select b.village as name, count(*)::int as count
      from base b
      where b.village is not null and b.village <> ''
        ${district ? 'and b.district = $2' : ''}
        ${block ? (district ? 'and b.block = $3' : 'and b.block = $2') : ''}
      group by b.village
      order by name asc`;

    // Bind params
    {
      const params: any[] = [];
      if (days !== null) { sqlD = sqlD.replace('$DAYS$', '$1'); params.push(days); }
      if (block) params.push(block);
      var dRows = await pool.query(sqlD, params);
    }
    {
      const params: any[] = [];
      if (days !== null) { sqlB = sqlB.replace('$DAYS$', '$1'); params.push(days); }
      if (district) params.push(district);
      var bRows = await pool.query(sqlB, params);
    }
    {
      const params: any[] = [];
      if (days !== null) { sqlV = sqlV.replace('$DAYS$', '$1'); params.push(days); }
      if (district) params.push(district);
      if (block)    params.push(block);
      var vRows = await pool.query(sqlV, params);
    }

    return res.json({
      ok: true,
      ...(days !== null ? { days } : {}),
      filters: {
        districts: (dRows.rows || []).map(r => ({ name: r.name, count: Number(r.count || 0) })),
        blocks:    (bRows.rows || []).map(r => ({ name: r.name, count: Number(r.count || 0) })),
        villages:  (vRows.rows || []).map(r => ({ name: r.name, count: Number(r.count || 0) })),
      }
    });
  } catch (e: any) {
    console.error('/api/dashboard/leads/filters error:', e?.message || e);
    return res.status(500).json({ ok: false, message: e?.message || 'Failed to load leads filters' });
  }
});

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

// Safe boolean parser for query/body flags (treats "false", "0", "no" as false)
function parseBoolFlag(v: any): boolean {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return false;
  if (['0','false','no','off','n'].includes(s)) return false;
  if (['1','true','yes','on','y'].includes(s)) return true;
  return false;
}
// ---- Unified: Aadhaar/Mobile ----
app.post("/api/search/number", async (req: Request, res: Response) => {
  const raw = String(req.body?.number || req.body?.aadhaar || req.body?.mobile || "").trim().replace(/\s+/g, '');
  const { kind, normalized } = classifyInputNumber(raw);
  const qForce = (req.query as any)?.force;
  const bForce = parseBoolFlag(qForce ?? req.body?.force);
  const force = bForce === true;

  // Parse optional days filter from query or body, or infer from Referer if absent
  const daysRaw = (req.query as any)?.days ?? req.body?.days;
  const daysNum = Number(daysRaw);
  let daysFilter: number | null = Number.isFinite(daysNum) && daysNum > 0 ? daysNum : null;
  if (daysFilter == null) {
    const ref = String((req.headers as any)?.referer || (req.headers as any)?.referrer || '');
    const m = ref.match(/[?&]days=(\d+)/);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) daysFilter = n;
    }
  }

  if (!normalized || kind === "invalid") {
    return res.status(400).json({ ok: false, message: "Enter a valid Mobile (10 digits, with/without +91/0) or Aadhaar (12 digits)." });
  }

  console.log(`[search/number] number=${normalized} kind=${kind} force=${force}`);
  let tnCalled = false;

  if (!force) {
    const cached = daysFilter
      ? await getApplicationsByNumberWithinDays(normalized, daysFilter)
      : await getApplicationsByNumber(normalized);
    console.log(`[search/number] cache length=${cached.length}`);
    if (cached.length) {
      res.setHeader("x-sla-cache", "hit");
      res.setHeader("x-sla-tn", "skipped");
      if (daysFilter) res.setHeader('x-sla-days', String(daysFilter));
      const enriched = await enrichApplicationsWithEligibility(cached as any);
      return res.json({ ok: true, applications: enriched, cached: true, message: "Data already available in Farmhost DB.", ...(daysFilter ? { days: daysFilter } : {}) });
    }
  }

  try {
    console.log(`[search/number] cache-miss -> calling TNHorti`);
    tnCalled = true;
    const mapped = await fetchAppsByNumberFromTN(normalized);
    console.log(`[search/number] TN returned ${mapped.length} rows`);
    if (mapped.length) {
      await persistAppsSurveysStatusesMeta(mapped as any);
      // Additionally, persist granular survey tuples (handles nested arrays from TN if present)
      try {
        const hasGeo = await ensureSurveySchema();
        for (const a of mapped) {
          const tuples = extractSurveyTuplesFromApp(a);
          for (const t of tuples) {
            if (hasGeo) {
              await upsertApplicationSurvey(t.appId, t.survey_no, t.subdivision_no, t.district, t.block, t.village);
            } else {
              await upsertApplicationSurvey(t.appId, t.survey_no, t.subdivision_no);
            }
          }
        }
      } catch (e) {
        console.warn('[number→surveys] granular upsert skipped:', (e as any)?.message || e);
      }
      // When a days filter is requested, re-read from DB using the same eligibility window to ensure consistency
      if (daysFilter) {
        const filtered = await getApplicationsByNumberWithinDays(normalized, daysFilter);
        res.setHeader("x-sla-cache", "miss");
        res.setHeader("x-sla-tn", "called");
        if (daysFilter) res.setHeader('x-sla-days', String(daysFilter));
        const enriched = await enrichApplicationsWithEligibility(filtered as any);
        return res.json({ ok: true, applications: enriched, cached: false, days: daysFilter });
      }
      res.setHeader("x-sla-cache", "miss");
      res.setHeader("x-sla-tn", "called");
      if (daysFilter) res.setHeader('x-sla-days', String(daysFilter));
      const enriched = await enrichApplicationsWithEligibility(mapped as any);
      return res.json({ ok: true, applications: enriched, cached: false });
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

type BulkJobStatus = "queued" | "running" | "paused" | "done" | "error" | "canceled";
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

async function createBulkJob(total: number, created_by?: string | null, desiredId?: string | null): Promise<string> {
  if (desiredId) {
    // try to use the provided id if unique
    const exists = await pool.query(`SELECT 1 FROM bulk_jobs WHERE id = $1`, [desiredId]);
    if (!exists.rowCount) {
      const { rows } = await pool.query(
        `INSERT INTO bulk_jobs (id, status, total, done, ok, error, created_by)
         VALUES ($1, 'queued', $2, 0, 0, 0, $3)
         RETURNING id::text`,
        [desiredId, total, created_by ?? null]
      );
      return rows[0].id as string;
    }
  }
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
    values.push(jobId, normalized, kind, "pending", "Queued for processing");
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
    values.push(jobId, val, "application", "pending", "Queued for processing");
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
    `SELECT 
        id,
        number,
        kind,
        state AS status,
        message,
        created_at,
        updated_at,
        -- Friendly display that preserves meaning even when the stored number is normalized
        CASE 
          WHEN lower(kind) = 'mobile' THEN 
            CASE WHEN length(regexp_replace(number,'[^0-9]','','g')) >= 10
                 THEN '+91 ' || right(regexp_replace(number,'[^0-9]','','g'), 10)
                 ELSE number END
          WHEN lower(kind) = 'aadhaar' THEN 
            CASE WHEN length(regexp_replace(number,'[^0-9]','','g')) = 12
                 THEN regexp_replace(regexp_replace(number,'[^0-9]','','g'),'^(\\d{4})(\\d{4})(\\d{4})$','\\1 \\2 \\3')
                 ELSE number END
          ELSE number
        END AS display_number
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

    // --- 1. Fetch mobiles for any appIds collected from job items and add to mobiles ---
    if (appIds.size) {
      const q = await client.query(
        `SELECT DISTINCT mobile
           FROM public.applications
          WHERE application_id = ANY($1::text[])`,
        [Array.from(appIds)]
      );
      for (const r of q.rows) {
        const m = String(r.mobile || '').replace(/\D/g, '').slice(-10);
        if (m && /^\d{10}$/.test(m)) mobiles.push(m);
      }
    }
    // dedupe mobiles
    const mobileSet = new Set<string>(mobiles.filter(Boolean));
    mobiles.length = 0; mobiles.push(...mobileSet);

    // 2) Expand appIds using numbers processed in this job (mobiles)
    if (mobiles.length) {
      const q = await client.query(
        `SELECT application_id FROM public.applications WHERE mobile = ANY($1::text[])`,
        [mobiles]
      );
      for (const r of q.rows) appIds.add(r.application_id);
    }
    // 2b) Expand appIds using aadhaars (as before)
    if (aadhaars.length) {
      const aadhaarSet = new Set<string>(aadhaars.filter(Boolean));
      const aadhaarArr = Array.from(aadhaarSet);
      if (aadhaarArr.length) {
        const q = await client.query(
          `SELECT application_id FROM public.applications WHERE aadhaar = ANY($1::text[])`,
          [aadhaarArr]
        );
        for (const r of q.rows) appIds.add(r.application_id);
      }
    }

    // --- Exclusion logic: protect items already available locally ---
const exRowsQ = await client.query(
  `SELECT number, kind, message FROM public.bulk_job_items WHERE job_id = $1 AND message ILIKE '%available in farmhost db%'`,
  [jobId]
);
const excludeAppIds = new Set<string>();
const excludeMobiles = new Set<string>();
for (const r of (exRowsQ.rows || [])) {
  const kind = String(r.kind || '').toLowerCase();
  const num = String(r.number || '').trim();
  if (!num) continue;
  if (kind === 'application') {
    excludeAppIds.add(num);
  } else if (kind === 'mobile') {
    const m = num.replace(/\D/g, '').slice(-10);
    if (/^\d{10}$/.test(m)) excludeMobiles.add(m);
  }
}
// From excluded application ids → mobiles
if (excludeAppIds.size) {
  const mQ = await client.query(
    `SELECT DISTINCT mobile FROM public.applications WHERE application_id = ANY($1::text[]) AND mobile IS NOT NULL`,
    [Array.from(excludeAppIds)]
  );
  for (const rr of mQ.rows) {
    const m = String(rr.mobile || '').replace(/\D/g, '').slice(-10);
    if (/^\d{10}$/.test(m)) excludeMobiles.add(m);
  }
}
// From excluded mobiles → all their application ids
if (excludeMobiles.size) {
  const aQ = await client.query(
    `SELECT application_id FROM public.applications WHERE mobile = ANY($1::text[])`,
    [Array.from(excludeMobiles)]
  );
  for (const rr of aQ.rows) excludeAppIds.add(String(rr.application_id));
}

// Apply exclusions to the deletion set
if (excludeAppIds.size) {
  for (const id of excludeAppIds) appIds.delete(id);
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

// put this small helper just ABOVE patchBulkItem (once):
function stripSS(msg?: string | null): string {
  if (typeof msg !== 'string') return '';
  let s = msg.trim();
  // Remove any embedded or trailing "SS: ..." segments, with or without bullets/dashes
  // Cases handled:
  //   "... • SS: text"
  //   "... - SS: text"
  //   "SS: text" (at start)
  //   multiple occurrences
  s = s.replace(/[\s]*[•\-]?[\s]*SS:\s*[^|]*$/gi, '');     // strip trailing SS to end
  s = s.replace(/(?:^|\s)[•\-]?\s*SS:\s*[^•\-]+(?=\s[•\-]|$)/gi, ''); // strip embedded SS chunks between tokens
  // Clean up duplicate spaces and stray separators left behind
  s = s.replace(/\s{2,}/g, ' ').replace(/\s*[•\-]\s*$/g, '').trim();
  return s;
}

async function patchBulkItem(jobId: string, number: string, status: BulkItemStatus, message: string) {
  const rawMsg = String(message || '').trim() ||
    (status === 'processing'
      ? 'Processing…'
      : status === 'ok'
        ? 'Completed'
        : status === 'error'
          ? 'Processing failed'
          : 'Queued for processing');
  const msg = stripSS(rawMsg);
  await pool.query(
    `UPDATE bulk_job_items
     SET state = $3, message = $4, updated_at = now()
     WHERE job_id = $1
       AND (
         number = $2
         OR regexp_replace(number, '[^0-9]', '', 'g') = regexp_replace($2, '[^0-9]', '', 'g')
       )`,
    [jobId, number, status, msg]
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
    return { ok: true, message: MSG_LOCAL };
  }
  // 2) TN
  const mapped = await fetchAppsByNumberFromTN(normalized);
  if (mapped.length) {
    await persistAppsSurveysStatusesMeta(mapped as any);
    return { ok: true, message: MSG_FETCHED };
  }
  return { ok: true, message: "No applications found – Farmer hasn’t used the services" };
}

// NOTE: it.number is the classifier's normalized value (12-digit Aadhaar or 10-digit mobile). Do not strip prefixes here.
// ---- Bulk job status messages ----
const MSG_CHECKING_LOCAL = "Checking Farmhost DB for existing records.";
const MSG_LOCAL = "Data already available in Farmhost DB.";
const MSG_FETCHING = "Fetching missing details from TN Government sources.";
const MSG_FETCHED = "Fetched data from TN Government.";

async function processBulkJob(jobId: string) {
  await setJobStatus(jobId, "running");
  const REQUIRED_FIELDS: Array<keyof AppRow> = [
    "crop_type",
    "mi_name",
    "applied_date",
    "farmer_name",
    "mi_area",
    "total_area",
    "survey_no",
    "subdivision_no",
    "farmer_type",
    "ss",
  ];
  // Before starting, check if job still exists and not canceled
  const activeBefore = await pool.query(`SELECT status FROM public.bulk_jobs WHERE id=$1`, [jobId]);
  const stBefore = String(activeBefore.rows?.[0]?.status || '').toLowerCase();
if (!activeBefore.rowCount || stBefore === "canceled" || stBefore === "paused") {
    return; // abort early if already canceled/deleted
  }

  let anyError = false;
  try {
    const itemsAll = await getBulkItems(jobId, 100000);
const items = itemsAll.filter(it => {
  const s = String(it.status || '').toLowerCase();
  return s !== 'ok' && s !== 'error';
});

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
        const stNow = String(q.rows?.[0]?.status || '').toLowerCase();
if (!q.rowCount || stNow === "canceled" || stNow === "paused") {
          return; // stop processing further items
        }
      } catch {}

      try {
        const rawVal = String(it.number);
        if (String(it.kind) === "application") {
          const appId = rawVal;
          // 0) Start
          await patchBulkItem(jobId, appId, "processing", MSG_CHECKING_LOCAL);

          // 1) Load local row first
          let appRow: any = null;
          try { appRow = await getApplicationFullById(appId); } catch {}

          // 1a) If district/block/village or mobile are missing, try to enrich minimal meta once
          if (!appRow || !appRow.district || !appRow.block || !appRow.village || !appRow.mobile) {
            try { await fetchAndStorePrintMeta(appId); } catch {}
            try { appRow = await getApplicationFullById(appId); } catch {}
          }

          // 1b) If this application is already complete locally, **do nothing**
          if (appRow) {
            const completeLocal = REQUIRED_FIELDS.every((k) => (appRow as any)[k] != null && String((appRow as any)[k]).trim() !== "");
            const hasMeta = !!(appRow.district || appRow.block || appRow.village);
            if (completeLocal && hasMeta) {
              await patchBulkItem(jobId, appId, "ok", MSG_LOCAL);
              await bumpJobCounters(jobId, 1, 1, 0);
              return;
            }
          }

          // 2) Identify contact from local row (prefer mobile; else aadhaar)
          const mDigits = appRow?.mobile ? String(appRow.mobile).replace(/\D/g, "").slice(-10) : null;
          const aDigits = appRow?.aadhaar ? String(appRow.aadhaar).replace(/\D/g, "") : null;
          const mobile10  = mDigits && /^\d{10}$/.test(mDigits)   ? mDigits  : null;
          const aadhaar12 = aDigits && /^\d{12}$/.test(aDigits) ? aDigits : null;
          const contact = mobile10 || aadhaar12 || null;

          // 3) Only call TN if contact’s local apps need enrichment
          if (contact) {
            // Prefer LOCAL for this contact; only call TN if enrichment is needed
            let cachedByContact: AppRow[] = [];
            try { cachedByContact = await getApplicationsByNumber(contact); } catch { cachedByContact = []; }
            const hasLocal = cachedByContact && cachedByContact.length > 0;
            const needsEnrichment = !hasLocal || cachedByContact.some((a: any) =>
              REQUIRED_FIELDS.some((k) => (a as any)[k] == null || String((a as any)[k]).trim() === "")
            );

            if (!needsEnrichment) {
            await patchBulkItem(jobId, appId, "ok", MSG_LOCAL);
              await bumpJobCounters(jobId, 1, 1, 0);
              return;
            }

            await patchBulkItem(jobId, appId, "processing", MSG_FETCHING);
            let mapped: any[] = [];
            try { mapped = await fetchAppsByNumberFromTN(contact); } catch { mapped = []; }
            if (mapped.length) {
              await upsertApplications(mapped as any);

              // Link identifiers across all returned apps so future searches are unified
              let linkRows: any[] = [];
              if (mobile10) {
                const aadFromMapped = mapped.find(a => (a as any).aadhaar)?.aadhaar || aadhaar12 || null;
                linkRows = mapped.map(a => ({ application_id: a.application_id, source: "number", mobile: mobile10, ...(aadFromMapped ? { aadhaar: aadFromMapped } : {}) }));
              } else if (aadhaar12) {
                const mobFromMapped = mapped.find(a => (a as any).mobile)?.mobile || mobile10 || null;
                linkRows = mapped.map(a => ({ application_id: a.application_id, source: "number", aadhaar: aadhaar12, ...(mobFromMapped ? { mobile: mobFromMapped } : {}) }));
              }
              if (linkRows.length) { await upsertApplications(linkRows as any); }

              // Persist surveys (prefer granular tuples if TN returns nested lists; fallback to simple replace)
              try {
                for (const a of mapped) {
                  let didGranular = false;
                  try {
                    const tuples = extractSurveyTuplesFromApp(a);
                    if (Array.isArray(tuples) && tuples.length) {
                      for (const t of tuples) {
                        await upsertApplicationSurvey(
                          t.appId,
                          t.survey_no,
                          t.subdivision_no,
                          t.district,
                          t.block,
                          t.village
                        );
                      }
                      didGranular = true;
                    }
                  } catch (_) {
                    // fall through to replace
                  }
                  if (!didGranular) {
                    await replaceApplicationSurveys(
                      a.application_id,
                      (a as any).survey_no ?? null,
                      (a as any).subdivision_no ?? null
                    );
                  }
                }
              } catch (e) {
                console.warn('[bulk/appId→surveys] upsert/replace skipped:', (e as any)?.message || e);
              }

              // Enrich every related application (best-effort)
              for (const a of mapped) {
                try { await fetchAndStoreStatuses(a.application_id); } catch {}
                try { await fetchAndStorePrintMeta(a.application_id); } catch {}
              }

              await patchBulkItem(jobId, appId, "ok", MSG_FETCHED);
              await bumpJobCounters(jobId, 1, 1, 0);
              return;
            } else {
              // TN returned no apps; at least ensure statuses for this AppID
              try { await fetchAndStoreStatuses(appId); } catch {}
              await patchBulkItem(jobId, appId, "ok", MSG_FETCHED);
              await bumpJobCounters(jobId, 1, 1, 0);
              return;
            }
          }

          // 4) No mobile or aadhaar on print page → at least store statuses for the AppID
          try { await fetchAndStoreStatuses(appId); } catch {}
          await patchBulkItem(jobId, appId, "ok", MSG_FETCHED);
          await bumpJobCounters(jobId, 1, 1, 0);
          return;
        }

        // --- Unified number normalization and patching for bulk jobs ---
        const cls = classifyInputNumber(rawVal);
        const numKey = cls.normalized || rawVal.replace(/\D/g, '');
        if (cls.kind === "invalid" || !numKey) {
          await patchBulkItem(jobId, numKey || rawVal, "error", "Invalid number format");
          await bumpJobCounters(jobId, 1, 0, 1);
          anyError = true;
          return;
        }

        // Always patch processing with the normalized key so later updates hit the same row
        await patchBulkItem(jobId, numKey, "processing", MSG_CHECKING_LOCAL);

        const cached = await getApplicationsByNumber(numKey);
        if (cached.length) {
          // For Aadhaar: if we already have any local rows, DO NOT call TN at all.
          if (cls.kind === "aadhaar") {
            await patchBulkItem(jobId, numKey, 'ok', MSG_LOCAL);
            await bumpJobCounters(jobId, 1, 1, 0);
            return;
          }

          // For Mobile: only call TN if enrichment is actually needed
          const needsEnrichment = cached.some((a: any) => {
            return REQUIRED_FIELDS.some((k) => a[k] == null || String(a[k]).trim() === '');
          });
          if (!needsEnrichment) {
            // Local data complete → stop here
            await patchBulkItem(jobId, numKey, 'ok', MSG_LOCAL);
            await bumpJobCounters(jobId, 1, 1, 0);
            return;
          }
          // Else continue below to fetch from TN to enrich missing fields
        }

        // At this point, either no local data or incomplete data: fetch from TN
        await patchBulkItem(jobId, numKey, "processing", MSG_FETCHING);
        const mapped = await fetchAppsByNumberFromTN(numKey);
        if (mapped.length) {
          await upsertApplications(mapped as any);
          // Link identifiers: after upsert, if any mapped row has aadhaar/mobile, upsert for all
          let linkRows: any[] = [];
          if (cls.kind === "mobile") {
            const aadhaar = mapped.find(a => a.aadhaar) ? mapped.find(a => a.aadhaar)?.aadhaar : null;
            linkRows = mapped.map(a => ({
              application_id: a.application_id,
              source: "number",
              mobile: numKey,
              ...(aadhaar ? { aadhaar } : {})
            }));
          } else if (cls.kind === "aadhaar") {
            const mobile = mapped.find(a => a.mobile) ? mapped.find(a => a.mobile)?.mobile : null;
            linkRows = mapped.map(a => ({
              application_id: a.application_id,
              source: "number",
              aadhaar: numKey,
              ...(mobile ? { mobile } : {})
            }));
          }
          if (linkRows.length) {
            await upsertApplications(linkRows as any);
          }
          // Persist surveys (prefer granular tuples if TN returns nested lists; fallback to simple replace)
          try {
            for (const a of mapped) {
              let didGranular = false;
              try {
                const tuples = extractSurveyTuplesFromApp(a);
                if (Array.isArray(tuples) && tuples.length) {
                  for (const t of tuples) {
                    await upsertApplicationSurvey(
                      t.appId,
                      t.survey_no,
                      t.subdivision_no,
                      t.district,
                      t.block,
                      t.village
                    );
                  }
                  didGranular = true;
                }
              } catch (_) {
                // fall through to replace
              }
              if (!didGranular) {
                await replaceApplicationSurveys(
                  a.application_id,
                  (a as any).survey_no ?? null,
                  (a as any).subdivision_no ?? null
                );
              }
            }
          } catch (e) {
            console.warn('[bulk/number→surveys] upsert/replace skipped:', (e as any)?.message || e);
          }
          for (const app of mapped) {
            try { await fetchAndStoreStatuses(app.application_id); } catch {}
            try { await fetchAndStorePrintMeta(app.application_id); } catch {}
          }
          await patchBulkItem(
            jobId,
            numKey,
            "ok",
            MSG_FETCHED
          );
          await bumpJobCounters(jobId, 1, 1, 0);
        } else {
          // No applications found at all
          await patchBulkItem(jobId, numKey, "ok", "No applications found – Farmer hasn’t used the services");
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
    // If user canceled, keep 'canceled' status; otherwise set terminal status
    try {
      const q = await pool.query(`SELECT status FROM public.bulk_jobs WHERE id=$1`, [jobId]);
      const st = String(q.rows?.[0]?.status || '').toLowerCase();
      if (st !== 'canceled' && st !== 'paused') {
        await setJobStatus(jobId, anyError ? 'error' : 'done');
      }
    } catch {
      // Fallback: if we cannot read status, set terminal status
      await setJobStatus(jobId, anyError ? 'error' : 'done');
    }
  }
}

/* ---------------- Bulk routes (DB-backed) ---------------- */

// List recent bulk jobs (last N days). If you don't scope by user, this returns all recent jobs.
app.get("/api/bulk/recent", async (req: Request, res: Response) => {
  try {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    const days = Math.max(1, Math.min(30, parseInt(String(req.query.days ?? "2"), 10) || 2));

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
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    const { rows } = await pgQueryRetry(
      `select id::text, status, total, done, ok, error, created_at::text, updated_at::text, created_by
         from bulk_jobs
        order by created_at desc
        limit 1`,
      [],
      3
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
    const rawNums = req.body?.numbers;
    const rawApps = (req.body?.appIds ?? req.body?.appids ?? req.body?.application_ids ?? req.body?.applicationIds ?? req.body?.ids);

    // Coercers: allow arrays, CSV strings, newline strings, or JSON-encoded strings
    const coerceList = (v: any): string[] => {
      if (Array.isArray(v)) return v.map((x) => String(x ?? ''));
      if (typeof v === 'string') {
        const s = v.trim();
        if (!s) return [];
        // try JSON first
        try {
          const parsed = JSON.parse(s);
          if (Array.isArray(parsed)) return parsed.map((x: any) => String(x ?? ''));
        } catch (_) {}
        // fallback: split by newlines/commas/semicolons
        return s.split(/[\n,;]+/).map((x) => x.trim()).filter(Boolean);
      }
      return [];
    };

    if (
      (!Array.isArray(rawNums) && typeof rawNums !== 'string' && !rawNums) &&
      (!Array.isArray(rawApps) && typeof rawApps !== 'string' && !rawApps)
    ) {
      console.warn('[bulk/start] bad payload: neither numbers[] nor appIds[] present');
      return res.status(400).json({ ok: false, message: "numbers[] or appIds[] required (array, CSV, or string)" });
    }

    const nums: string[] = coerceList(rawNums).map((s) => s.trim()).filter((s) => s.length > 0);
    const appIds: string[] = coerceList(rawApps).map((s) => s.trim()).filter((s) => s.length > 0);

    console.log('[bulk/start] received', { numbers: nums.length, appIds: appIds.length });

    if (nums.length === 0 && appIds.length === 0) {
      return res.status(400).json({ ok: false, message: "No items to process." });
    }

    const created_by = String(req.body?.created_by || "").trim() || null;
    const total = nums.length + appIds.length;
    let jobId: string;
    try {
      jobId = await createBulkJob(total, created_by);
    } catch (e: any) {
      console.error('[bulk/start] createBulkJob failed:', e?.message || e);
      return res.status(500).json({ ok: false, message: 'Failed to create job (DB schema mismatch?)' });
    }
    try {
      if (nums.length) await insertBulkItems(jobId, nums);
      if (appIds.length) await insertBulkAppItems(jobId, appIds);
    } catch (e: any) {
      console.error('[bulk/start] insert items failed:', e?.message || e);
      return res.status(500).json({ ok: false, message: 'Failed to insert job items (check bulk_job_items schema).'});
    }

    console.log('[bulk/start] job created', { jobId, total });

    // async fire-and-forget
    processBulkJob(jobId).catch((e) => console.error('[bulk] processor error:', e));

    return res.json({ ok: true, jobId });
  } catch (e: any) {
    console.error('/api/bulk/start error:', e);
    return res.status(500).json({ ok: false, message: e?.message || 'Failed to start bulk job' });
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
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  const jobId = String(req.params.id || "").trim();
  if (!jobId) return res.status(400).json({ ok: false, message: "Missing job id" });
  try {
    // Load job row
    const jobQ = await pgQueryRetry(
      `SELECT id::text, status, total, done, ok, error,
              created_at::text, updated_at::text, created_by
         FROM public.bulk_jobs
        WHERE id = $1`,
      [jobId],
      3
    );
    if (jobQ.rowCount === 0) return res.status(404).json({ ok: false, message: "Job not found" });
    const job = jobQ.rows[0];

    // Load items directly (schema-agnostic) and normalize in JS
    let raw: any[] = [];
    try {
      const itemsQ = await pgQueryRetry(
        `SELECT *
           FROM public.bulk_job_items
          WHERE job_id = $1
          ORDER BY id ASC
          LIMIT 10000`,
        [jobId],
        3
      );
      raw = itemsQ.rows || [];
    } catch (e: any) {
      console.error('[bulk status] items fetch final failure:', e?.message || e);
      raw = [];
    }
    let items: Array<{ number: string; kind: string; state: string; message: string; updated_at: any }>;
    items = raw.map((it: any) => ({
      number: String(it.number ?? it.input ?? it.value ?? it.raw ?? ""),
      kind: String((it.kind ?? it.item_kind ?? it.type ?? 'unknown')).toLowerCase(),
      state: String((it.state ?? it.status ?? it.result ?? 'pending')).toLowerCase(),
      message: String(it.message ?? it.detail ?? it.last_message ?? ''),
      updated_at: it.updated_at ?? it.created_at ?? null,
    }));

    // Ensure messages are always present and human-friendly
    items = items.map((it) => {
      const msg = String(it.message || '').trim();
      if (msg) return it;
      let fallback = '';
      switch (it.state) {
        case 'pending':    fallback = 'Queued for processing'; break;
        case 'processing': fallback = 'Processing…'; break;
        case 'ok':         fallback = 'Completed'; break;
        case 'error':      fallback = 'Processing failed'; break;
        default:           fallback = 'Queued for processing';
      }
      return { ...it, message: fallback };
    });

    // Strip any trailing SS summary from messages for clean UI
    for (const it of items as any[]) {
      if (it && typeof it.message === 'string') {
        it.message = stripSS(it.message);
      }
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

// Tiny debug endpoint to peek at recent jobs
app.get('/api/bulk/debug/peek', async (_req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT id::text, status, total, done, ok, error, created_at::text, created_by
         FROM public.bulk_jobs
        ORDER BY created_at DESC
        LIMIT 5`);
    return res.json({ ok: true, jobs: rows });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message || 'peek failed' });
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

// Pause a job (non-destructive: keeps items and progress)
app.post("/api/bulk/:id/pause", async (req: Request, res: Response) => {
  res.set("Content-Type", "application/json");
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).json({ ok: false, message: "Missing job id" });
  try {
    await setJobStatus(id, "paused");
    // Do not mutate item states; workers check paused and stop naturally
    return res.json({ ok: true, paused: true });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message || "Failed to pause job" });
  }
});

// Resume a paused job (continues remaining items)
app.post("/api/bulk/:id/resume", async (req: Request, res: Response) => {
  res.set("Content-Type", "application/json");
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).json({ ok: false, message: "Missing job id" });
  try {
    // Mark queued (processor will set running) and fire the worker
    await setJobStatus(id, "queued");
    processBulkJob(id).catch((e) => console.error('[bulk/resume] processor error:', e));
    return res.json({ ok: true, status: 'queued' });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message || "Failed to resume job" });
  }
});

// Cancel a job (stop processing only; do not purge or delete)
app.post("/api/bulk/:id/cancel", async (req: Request, res: Response) => {
  res.set("Content-Type", "application/json");
  const id = String(req.params.id || "").trim();
  if (!id) return res.status(400).json({ ok: false, message: "Missing job id" });
  try {
    // Mark job as canceled
    await setJobStatus(id, "canceled");

    // Mark any pending/processing items to error with a clear message for UI
    await pool.query(
      `UPDATE public.bulk_job_items
         SET state = 'error', message = 'Canceled by user', updated_at = now()
       WHERE job_id = $1 AND lower(coalesce(state,'')) IN ('pending','processing')`,
      [id]
    );

    return res.json({ ok: true, canceled: true });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message || "Failed to cancel job" });
  }
});

// Fallback: allow POST /api/bulk/cancel { id } (stop processing only)
app.post("/api/bulk/cancel", async (req: Request, res: Response) => {
  res.set("Content-Type", "application/json");
  const id = String(req.body?.id || "").trim();
  if (!id) return res.status(400).json({ ok: false, message: "Missing job id" });
  try {
    await setJobStatus(id, "canceled");
    await pool.query(
      `UPDATE public.bulk_job_items
         SET state = 'error', message = 'Canceled by user', updated_at = now()
       WHERE job_id = $1 AND lower(coalesce(state,'')) IN ('pending','processing')`,
      [id]
    );
    return res.json({ ok: true, canceled: true });
  } catch (e: any) {
    return res.status(500).json({ ok: false, message: e?.message || "Failed to cancel job" });
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

// ================= Customer Summary (by mobile) =================
// GET /api/customers/summary?mobile=XXXXXXXXXX
app.get('/api/customers/summary', async (req: Request, res: Response) => {
  try {
    const raw = String((req.query as any)?.mobile || '');
    const m10 = normalizeMobile10Strict(raw);
    if (!m10) {
      return res.json({
        ok: true, key: '', applications: [],
        total_applications: 0, total_area: 0, total_mi_area: 0,
        districts: [], blocks: [], villages: [], crops: [], mi_names: []
      });
    }

    // Guard: does applications have 'aadhaar'?
    const hasAadhaarCol = await pool.query(
      `select 1 from information_schema.columns where table_schema='public' and table_name='applications' and column_name='aadhaar' limit 1`
    ).then(r => r.rowCount === 1).catch(() => false);

    let apps: any[] = [];
    if (hasAadhaarCol) {
      const sql = `
        WITH base AS (
          SELECT a.*
            FROM public.applications a
           WHERE RIGHT(regexp_replace(COALESCE(a.mobile,''),'[^0-9]','','g'),10) = $1
        ), linked AS (
          SELECT a.*
            FROM public.applications a
           WHERE RIGHT(regexp_replace(COALESCE(a.mobile,''),'[^0-9]','','g'),10) = $1
              OR RIGHT(regexp_replace(COALESCE(a.aadhaar,''),'[^0-9]','','g'),12) IN (
                   SELECT RIGHT(regexp_replace(COALESCE(b.aadhaar,''),'[^0-9]','','g'),12)
                     FROM base b
                    WHERE COALESCE(b.aadhaar,'') <> ''
                 )
        )
        SELECT * FROM linked`;
      const r = await pgQueryRetry(sql, [m10]);
      apps = r.rows || [];
    } else {
      // Fallback: no 'aadhaar' column — just pull by mobile
      const sql = `
        SELECT a.*
          FROM public.applications a
         WHERE RIGHT(regexp_replace(COALESCE(a.mobile,''),'[^0-9]','','g'),10) = $1`;
      const r = await pgQueryRetry(sql, [m10]);
      apps = r.rows || [];
    }

    // Surveys (only if table exists)
    const haveSurveyTable = await tableExists('public', 'application_surveys');
    const appIds = apps.map(r => r.application_id).filter(Boolean);
    const surveysByApp: Record<string, any[]> = {};
    if (haveSurveyTable && appIds.length) {
      try {
        const { rows: sv } = await pgQueryRetry(
          `SELECT application_id, survey_no, subdivision_no
             FROM public.application_surveys
            WHERE application_id = ANY($1::text[])`,
          [appIds]
        );
        for (const s of sv) {
          (surveysByApp[s.application_id] ||= []).push({
            survey_no: s.survey_no ?? null,
            subdivision_no: s.subdivision_no ?? null,
          });
        }
      } catch {
        // ignore survey errors entirely
      }
    }

    // Build response – tolerate missing columns gracefully
    const num = (v: any) => (v == null ? null : Number(v));
    const pick = (o: any, k: string) => (o && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null);

    const applications = apps.map(a => ({
      application_id: pick(a, 'application_id'),
      farmer_name: pick(a, 'farmer_name'),
      mobile: pick(a, 'mobile'),
      aadhaar: pick(a, 'aadhaar'),
      district: pick(a, 'district'),
      block: pick(a, 'block'),
      village: pick(a, 'village'),
      crop_type: pick(a, 'crop_type'),
      mi_name: pick(a, 'mi_name'),
      total_area: num(pick(a, 'total_area')),
      mi_area: num(pick(a, 'mi_area')),
      applied_date: pick(a, 'applied_date'),
      last_status: pick(a, 'ss'),
      last_status_date: null,
      completed_at: null,
      days_left: null,
      surveys: surveysByApp[pick(a, 'application_id')] || [],
    }));

    const uniq = (arr: any[]) => {
      const out: string[] = []; const seen = new Set<string>();
      for (const v of arr.map(x => (x ?? '').toString().trim()).filter(Boolean)) {
        const k = v.toLowerCase(); if (!seen.has(k)) { seen.add(k); out.push(v); }
      }
      return out;
    };

    const totalApplications = applications.length;
    const totalArea = applications.reduce((s, r: any) => s + (Number(r.total_area) || 0), 0);
    const totalMiArea = applications.reduce((s, r: any) => s + (Number(r.mi_area) || 0), 0);

    return res.json({
      ok: true,
      key: `+91${m10}`,
      applications,
      total_applications: totalApplications,
      total_area: Number(totalArea.toFixed(2)),
      total_mi_area: Number(totalMiArea.toFixed(2)),
      districts: uniq(applications.map(a => a.district)),
      blocks:    uniq(applications.map(a => a.block)),
      villages:  uniq(applications.map(a => a.village)),
      crops:     uniq(applications.map(a => a.crop_type)),
      mi_names:  uniq(applications.map(a => a.mi_name)),
    });
  } catch (e: any) {
    console.warn('/api/customers/summary error:', e?.message || e);
    // Never 500 – return empty instead
    return res.json({
      ok: true, key: '', applications: [],
      total_applications: 0, total_area: 0, total_mi_area: 0,
      districts: [], blocks: [], villages: [], crops: [], mi_names: []
    });
  }
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