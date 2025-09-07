import React from "react";

export default function Button({ children, className = "", ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={`px-4 py-2 rounded-xl bg-slate-900 text-white hover:opacity-90 dark:bg-slate-100 dark:text-slate-900 font-medium ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}