// client/src/pages/Dashboard.tsx
import React, { useMemo, useState } from "react";
import {
  ArrowPathIcon,
  BellAlertIcon,
  ChartBarIcon,
  ClipboardDocumentListIcon,
  UserGroupIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
} from "@heroicons/react/24/outline";

type Activity = { id: string; title: string; time: string; type?: "info" | "warn" | "ok" };

const RAW_STATS = {
  orders: 1245,
  clients: 532,
  csat: 0.89,
  issues: 12,
};

const RAW_ACTIVITY: Activity[] = [
  { id: "a1", title: "John Doe placed a new order (#1234).", time: "2 hours ago", type: "ok" },
  { id: "a2", title: "Inventory updated for product Rice Seeds.", time: "5 hours ago", type: "info" },
  { id: "a3", title: "New client AgroFarm Ltd. registered.", time: "1 day ago", type: "ok" },
  { id: "a4", title: "Monthly sales report generated.", time: "2 days ago", type: "info" },
];

export default function Dashboard() {
  const [refreshing, setRefreshing] = useState(false);

  const stats = useMemo(() => {
    // In real app, compute from API data
    return RAW_STATS;
  }, []);

  function refresh() {
    setRefreshing(true);
    // Simulate a refresh
    setTimeout(() => setRefreshing(false), 800);
  }

  return (
    <div className="mx-auto max-w-7xl">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
            Dashboard Overview
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Welcome back! Your latest updates and insights at a glance.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refresh}
            disabled={refreshing}
            className="inline-flex items-center gap-2 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2 text-sm font-medium text-slate-800 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500/30 disabled:opacity-60"
          >
            <ArrowPathIcon className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`} />
            Refresh
          </button>
          <button
            className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1"
          >
            <ClipboardDocumentListIcon className="h-4 w-4" />
            Export
          </button>
        </div>
      </div>

      {/* Quick Stats */}
      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
            label="Orders"
            value={stats.orders.toLocaleString()}
            icon={<ChartBarIcon className="h-5 w-5" />}
        />
        <StatCard
            label="Active Clients"
            value={stats.clients.toLocaleString()}
            icon={<UserGroupIcon className="h-5 w-5" />}
        />
        <StatCard
            label="Satisfaction"
            value={`${Math.round(stats.csat * 100)}%`}
            icon={<CheckCircleIcon className="h-5 w-5" />}
        />
        <StatCard
            label="Issues"
            value={stats.issues.toLocaleString()}
            intent="warn"
            icon={<ExclamationTriangleIcon className="h-5 w-5" />}
        />
      </section>

      {/* Two-column content */}
      <section className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Recent Activity */}
        <div className="lg:col-span-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
          <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-700 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Recent Activity</h2>
            <button className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700">
              <BellAlertIcon className="h-4 w-4" />
              View all
            </button>
          </div>
          <ul className="divide-y divide-slate-200 dark:divide-slate-700">
            {RAW_ACTIVITY.map((a) => (
              <li key={a.id} className="flex items-start gap-3 px-4 py-3">
                <span className={badgeClass(a.type)} />
                <div>
                  <p className="text-sm text-slate-800 dark:text-slate-100">{a.title}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{a.time}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>

        {/* Notifications / Notes */}
        <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800">
          <div className="border-b border-slate-200 dark:border-slate-700 px-4 py-3">
            <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Notifications</h2>
          </div>
          <div className="p-4">
            <div className="rounded-lg border border-amber-200/60 dark:border-amber-300/20 bg-amber-50 dark:bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200">
              System maintenance scheduled for tomorrow.
            </div>
            <div className="mt-3 rounded-lg border border-emerald-200/60 dark:border-emerald-300/20 bg-emerald-50 dark:bg-emerald-500/10 p-3 text-sm text-emerald-900 dark:text-emerald-200">
              New fertilizer shipment received and logged.
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  intent = "neutral",
}: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  intent?: "neutral" | "warn";
}) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-600 dark:text-slate-300">{label}</span>
        <div
          className={
            intent === "warn"
              ? "rounded-md bg-rose-500/10 text-rose-600 dark:text-rose-300 p-2"
              : "rounded-md bg-blue-500/10 text-blue-600 dark:text-blue-300 p-2"
          }
        >
          {icon}
        </div>
      </div>
      <div className="mt-2 text-2xl font-bold text-slate-900 dark:text-slate-100">{value}</div>
    </div>
  );
}

function badgeClass(t?: Activity["type"]) {
  switch (t) {
    case "ok":
      return "mt-1 inline-block h-2 w-2 rounded-full bg-emerald-500";
    case "warn":
      return "mt-1 inline-block h-2 w-2 rounded-full bg-rose-500";
    default:
      return "mt-1 inline-block h-2 w-2 rounded-full bg-slate-400";
  }
}