import React from "react";

export default function Badge({ tone = "default", children }: { tone?: "default" | "success" | "warn" | "info"; children: React.ReactNode }) {
  const map = {
    default: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
    success: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-200",
    warn: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
    info: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  } as const;
  return <span className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${map[tone]}`}>{children}</span>;
}