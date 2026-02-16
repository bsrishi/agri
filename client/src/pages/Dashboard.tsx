import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowPathIcon,
  CloudIcon,
  ClipboardDocumentCheckIcon,
  ChartBarIcon,
  UserGroupIcon,
  BuildingOffice2Icon,
  MapPinIcon,
  BuildingOfficeIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  BoltIcon,
} from "@heroicons/react/24/outline";

/**
 * Dashboard Overview
 * - No. of Farmers
 * - Total Applications
 * - Districts / Blocks / Villages covered
 * - Success Rate (items with statuses / total)
 * - Running/Queued Jobs
 * - Geo distribution (top Districts → Blocks → Villages)
 *
 * This page fetches from `/api/dashboard/overview`.
 * If your backend exposes a different path, adjust `STATS_URL` below.
 */

const API_BASE = (import.meta.env.VITE_API_URL || "").replace(/\/+$/, "");
const STATS_URL = `${API_BASE}/api/dashboard/overview`; // resolved at runtime
const FRAUD_URL = `${API_BASE}/api/dashboard/fraud`;

// ---------------- Types ----------------

type GeoRow = { name: string; count: number };

type FraudRow = {
  customer_key: string;
  mobile?: string | null;
  aadhaar?: string | null;
  applications: number;
  application_ids: string[];
  districts: string[];
  blocks: string[];
  villages: string[];
};

type Overview = {
  farmers: number; // distinct mobiles
  applications: number; // total apps in DB
  districts: number; // distinct districts
  blocks: number; // distinct blocks
  villages: number; // distinct villages
  with_statuses: number; // apps that have at least one status row
  jobs_running: number; // active bulk jobs in processing state
  jobs_queued: number; // pending jobs
  last_sync?: string | null; // ISO timestamp of last successful TN pull
  top_districts: GeoRow[]; // sorted desc
  top_blocks: GeoRow[]; // sorted desc
  top_villages: GeoRow[]; // sorted desc
  fraud?: FraudRow[];
};

// ---------------- Page ----------------

export default function Dashboard() {
  const [data, setData] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const acRef = useRef<AbortController | null>(null);

  async function load(force = false) {
    setError(null);

    // If we already have data, avoid full skeletons — mark as refreshing instead
    if (!data) {
      setLoading(true);
    } else {
      setRefreshing(true);
    }

    acRef.current?.abort();
    const ac = new AbortController();
    acRef.current = ac;
    let aborted = false;
    ac.signal.addEventListener("abort", () => { aborted = true; });

    try {
      // Fetch overview first
      const r = await fetch(`${STATS_URL}${force ? "?t=" + Date.now() : ""}`, {
        method: "GET",
        signal: ac.signal,
        credentials: "include",
        headers: { "Accept": "application/json" },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = (await r.json()) as Partial<Overview>;

      // Eagerly update the overview WITHOUT blocking on fraud
      const safeBase: Overview = {
        farmers: json.farmers ?? 0,
        applications: json.applications ?? 0,
        districts: json.districts ?? 0,
        blocks: json.blocks ?? 0,
        villages: json.villages ?? 0,
        with_statuses: json.with_statuses ?? 0,
        jobs_running: json.jobs_running ?? 0,
        jobs_queued: json.jobs_queued ?? 0,
        last_sync: json.last_sync ?? null,
        top_districts: (json.top_districts ?? []),
        top_blocks: (json.top_blocks ?? []),
        top_villages: (json.top_villages ?? []),
        // keep previous fraud while we refresh it in the background
        fraud: data?.fraud ?? [],
      };
      setData(safeBase);

      // Refresh fraud in the background (non-blocking)
      (async () => {
        try {
          const f = await fetch(FRAUD_URL, { credentials: "include", signal: ac.signal, headers: { "Accept": "application/json" } });
          if (f.ok) {
            const fj = await f.json();
            const fraud = (fj?.rows ?? []) as FraudRow[];
            if (!aborted) {
              setData(prev => prev ? { ...prev, fraud } : prev);
            }
          }
        } catch (fe: any) {
          // Ignore aborts; log others without disrupting UI
          if (fe?.name !== "AbortError") {
            console.warn("/api/dashboard/fraud error:", fe?.message || fe);
          }
        }
      })();

    } catch (e: any) {
      if (e?.name === "AbortError") return;
      setError(e?.message || "Load failed");
    } finally {
      if (!aborted) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }

  useEffect(() => {
    load();
    return () => acRef.current?.abort();
  }, []);

  const successRate = useMemo(() => {
    if (!data) return 0;
    if (!data.applications) return 0;
    const r = data.with_statuses / data.applications;
    return Math.round(r * 100);
  }, [data]);

  const initialLoading = loading && !data;

  return (
    <div className="mx-auto max-w-7xl px-3 sm:px-4 lg:px-6">
      {/* Header */}
      <div className="mb-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            Overview
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Information on Data available in Farmhost
          </p>
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <button
            onClick={() => load(true)}
            disabled={loading}
            className="w-full sm:w-auto inline-flex items-center justify-center gap-2 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-4 py-2.5 text-sm font-medium text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:opacity-60"
          >
            <ArrowPathIcon className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* Quick Stats */}
      <section className="grid grid-cols-1 gap-3 sm:gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {initialLoading ? (
          <>
            <SkeletonStatCard />
            <SkeletonStatCard />
            <SkeletonStatCard />
            <SkeletonStatCard />
          </>
        ) : (
          <>
            <StatCard label="Farmers" value={fmtNum(data?.farmers)} icon={<UserGroupIcon className="h-5 w-5" />} />
            <StatCard label="Applications" value={fmtNum(data?.applications)} icon={<ClipboardDocumentCheckIcon className="h-5 w-5" />} />
            <StatCard label="Districts" value={fmtNum(data?.districts)} icon={<BuildingOffice2Icon className="h-5 w-5" />} />
            <StatCard label="Blocks" value={fmtNum(data?.blocks)} icon={<BuildingOfficeIcon className="h-5 w-5" />} />
            <StatCard label="Villages" value={fmtNum(data?.villages)} icon={<MapPinIcon className="h-5 w-5" />} />
          </>
        )}
      </section>

      {/* Health / Sync row */}
      <section className="mt-4 grid grid-cols-1 gap-3 sm:gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3 sm:p-4 md:p-5 lg:col-span-2">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100 mb-3">Geographical Coverage (All)</h2>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <GeoList title="Applications by District" rows={data?.top_districts} loading={initialLoading} refreshing={refreshing} empty="No districts yet" />
            <GeoList title="Applications by Block" rows={data?.top_blocks} loading={initialLoading} refreshing={refreshing} empty="No blocks yet" />
            <GeoList title="Applications by Village" rows={data?.top_villages} loading={initialLoading} refreshing={refreshing} empty="No villages yet" />
          </div>
        </div>
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3 sm:p-4 md:p-5">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100 mb-3">System</h2>
          <div className="space-y-2 text-sm">
            <Row label="API Health" value={<span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-300"><CheckCircleIcon className="h-4 w-4"/> Healthy</span>} />
            <Row label="TN Sync" value={data?.last_sync ? new Date(data.last_sync).toLocaleString() : "—"} />
            <Row label="Backend" value={<span className="inline-flex items-center gap-1"><CloudIcon className="h-4 w-4"/> Nathiya Agri Agency</span>} />
            {error ? (
              <div className="mt-2 rounded-lg border border-rose-300/40 bg-rose-50 dark:border-rose-300/20 dark:bg-rose-500/10 p-2 text-rose-700 dark:text-rose-200">
                <div className="flex items-center gap-2 text-xs"><ExclamationTriangleIcon className="h-4 w-4"/> {error}</div>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <section className="mt-4 rounded-xl border border-rose-300 dark:border-rose-500 bg-rose-50 dark:bg-rose-900/30 p-3 sm:p-4 md:p-5">
        <h2 className="text-sm font-semibold text-rose-700 dark:text-rose-300 mb-3">Fraud Detection</h2>
        <FraudList rows={data?.fraud} loading={initialLoading} />
      </section>
    </div>
  );
}

// ---------------- UI Bits ----------------

function StatCard({ label, value, icon }: { label: string; value: string | number | undefined; icon: React.ReactNode; }) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3 sm:p-4 md:p-5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-600 dark:text-slate-300">{label}</span>
        <div className="rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-300 p-2">{icon}</div>
      </div>
      <div className="mt-2 text-xl sm:text-2xl font-bold text-slate-900 dark:text-slate-100">{value ?? "—"}</div>
    </div>
  );
}

function SkeletonStatCard() {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-3 sm:p-4 md:p-5">
      <div className="flex items-center justify-between">
        <span className="h-4 w-20 bg-slate-200/70 dark:bg-slate-700/50 rounded animate-pulse" />
        <span className="h-8 w-8 bg-slate-200/70 dark:bg-slate-700/50 rounded-md animate-pulse" />
      </div>
      <div className="mt-2 h-7 w-24 bg-slate-200/70 dark:bg-slate-700/50 rounded animate-pulse" />
    </div>
  );
}

function GeoList({ title, rows, empty, loading, refreshing }: { title: string; rows?: GeoRow[]; empty: string; loading?: boolean; refreshing?: boolean }) {
  if (loading) {
    return (
      <div>
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{title}</div>
        <ul className="max-h-[55vh] sm:max-h-96 overflow-y-auto divide-y divide-slate-200 dark:divide-slate-700 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
          {Array.from({length: 6}).map((_,i)=> (
            <li key={i} className="px-3 py-2">
              <div className="h-4 w-1/2 bg-slate-200/70 dark:bg-slate-700/50 rounded animate-pulse" />
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div>
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{title}</div>
      <ul className={("max-h-[55vh] sm:max-h-96 overflow-y-auto divide-y divide-slate-200 dark:divide-slate-700 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 transition-opacity duration-200 " + (refreshing ? "opacity-60" : "")).trim()}>
        {(rows?.length ? rows : []).map((r) => (
          <li key={r.name} className="flex items-center justify-between px-3 py-2 text-sm">
            <span className="truncate text-slate-800 dark:text-slate-100">{r.name}</span>
            <span className="font-semibold text-slate-900 dark:text-slate-100 tabular-nums">{fmtNum(r.count)}
              <span className="ml-1 text-[11px] font-normal text-slate-500 dark:text-slate-400">apps</span>
            </span>
          </li>
        ))}
        {!rows?.length && (
          <li className="px-3 py-3 text-sm text-slate-500 dark:text-slate-400">{empty}</li>
        )}
      </ul>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between text-slate-700 dark:text-slate-200">
      <span className="text-xs text-slate-500 dark:text-slate-400">{label}</span>
      <div className="text-sm">{value}</div>
    </div>
  );
}

function FraudList({ rows, loading }: { rows?: FraudRow[]; loading?: boolean }) {
  if (loading) {
    return (
      <ul className="divide-y divide-rose-200 dark:divide-rose-700">
        {Array.from({length: 4}).map((_,i)=> (
          <li key={i} className="py-2">
            <div className="h-4 w-2/3 bg-rose-200/50 dark:bg-rose-700/40 rounded animate-pulse" />
          </li>
        ))}
      </ul>
    );
  }
  if (!rows?.length) {
    return <div className="text-sm text-slate-500 dark:text-slate-400">No suspicious customers found.</div>;
  }
  return (
    <ul className="divide-y divide-rose-200 dark:divide-rose-700">
      {rows.map((r) => (
        <li key={r.customer_key} className="py-2 text-sm break-words">
          <span className="font-semibold">{r.mobile || r.aadhaar || r.customer_key}</span> — {r.applications} Applications across {r.districts.length} districts, {r.blocks.length} blocks, {r.villages.length} villages
        </li>
      ))}
    </ul>
  );
}

// ---------------- utils ----------------

function fmtNum(n?: number) {
  if (typeof n !== "number" || Number.isNaN(n)) return "—";
  return n.toLocaleString();
}