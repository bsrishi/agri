import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

function sanitizeBase(u: string): string {
  let s = (u || "").toString().trim();
  // remove leading/trailing single or double quotes if present
  s = s.replace(/^['"]+|['"]+$/g, "");
  // remove trailing slashes to avoid '//' when joining paths
  s = s.replace(/\/+$/g, "");
  return s;
}
const API_BASE = sanitizeBase(((import.meta as any)?.env?.VITE_API_URL ?? "") as string);
// Debug: which API base are we using?
if (typeof window !== "undefined") {
  try { console.debug("[Login] API_BASE =", API_BASE || "(same-origin)"); } catch {}
}

const PHONE_REGEX = /^(?:\+?91[-\s]?)?[6-9]\d{9}$/; // India mobile validation (lenient)

const OTP_LENGTH = 6;

function classNames(...arr: Array<string | false | null | undefined>) {
  return arr.filter(Boolean).join(" ");
}

const Login: React.FC = () => {
  const navigate = useNavigate();
  // Detect ?loggedout=1 in URL and show logout notice
  const params = new URLSearchParams(window.location.search);
  const initialNotice = params.get("loggedout") === "1"
    ? "You have been successfully logged out. Please login again."
    : null;
  // Delay rendering until notice is initialized to prevent flicker
  const [step, setStep] = useState<"phone" | "otp">("phone");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(initialNotice);

  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState<string[]>(Array.from({ length: OTP_LENGTH }, () => ""));

  const [secondsLeft, setSecondsLeft] = useState(0); // resend timer
  const [attempts, setAttempts] = useState(0);

  const otpRefs = useRef<HTMLInputElement[]>([]);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const t = setInterval(() => setSecondsLeft((s) => (s > 0 ? s - 1 : 0)), 1000);
    return () => clearInterval(t);
  }, [secondsLeft]);

  // Focus first OTP box when step flips to OTP
  useEffect(() => {
    if (step === "otp") {
      requestAnimationFrame(() => otpRefs.current[0]?.focus());
    }
  }, [step]);

  const formattedPhone = useMemo(() => {
    const digits = phone.replace(/\D/g, "");
    if (digits.startsWith("91") && digits.length === 12) return "+" + digits.slice(0, 2) + " " + digits.slice(2);
    if (digits.length === 10) return "+91 " + digits;
    return phone.trim();
  }, [phone]);

  const onSendOtp = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setError(null);
    if (notice !== "You have been successfully logged out. Please login again.") {
      setNotice(null);
    }

    const raw = phone.trim();
    if (!PHONE_REGEX.test(raw)) {
      setError("தவறான மொபைல் எண். Please enter a valid 10‑digit number.");
      return;
    }

    try {
      setLoading(true);
      // Normalize to E.164-like
      const digits = raw.replace(/\D/g, "");
      let e164 = raw;
      if (digits.length === 10) {
        e164 = `+91${digits}`;
      } else if (digits.length === 12 && digits.startsWith("91")) {
        e164 = `+${digits}`;
      } else if (!raw.startsWith("+") && digits.length >= 10) {
        e164 = `+${digits}`;
      }
      const res = await fetch(`${API_BASE ? API_BASE : ""}/auth/send-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: e164 })
      });
      if (!res.ok) {
        let payload: any = null;
        try { payload = await res.json(); } catch {}
        if (payload?.code === "no_access" || res.status === 403) {
          setError("You don’t have access to this application yet. Please contact the administrator.");
          return;
        }
        throw new Error(payload?.message || `Request failed (${res.status})`);
      }
      setStep("otp");
      setSecondsLeft(45);
      setAttempts((a) => a + 1);
      setNotice("OTP sent successfully.");
    } catch (err: any) {
      setError(err?.message || "Failed to send OTP. Try again.");
    } finally {
      setLoading(false);
    }
  };

  const onVerify = async () => {
    setError(null);
    if (notice !== "You have been successfully logged out. Please login again.") {
      setNotice(null);
    }
    const code = otp.join("");
    if (code.length !== OTP_LENGTH) {
      setError("Enter the 6‑digit OTP.");
      return;
    }
    try {
      setLoading(true);
      // Reuse the same normalization as send-otp
      const rawPhone = phone.trim();
      const digs = rawPhone.replace(/\D/g, "");
      let norm = rawPhone;
      if (digs.length === 10) {
        norm = `+91${digs}`;
      } else if (digs.length === 12 && digs.startsWith("91")) {
        norm = `+${digs}`;
      } else if (!rawPhone.startsWith("+") && digs.length >= 10) {
        norm = `+${digs}`;
      }
      const res = await fetch(`${API_BASE ? API_BASE : ""}/auth/verify-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: norm, otp: code })
      });
      if (!res.ok) {
        let payload: any = null;
        try { payload = await res.json(); } catch {}
        if (payload?.code === "no_access" || res.status === 403) {
          setError("You don’t have access to this application yet. Please contact the administrator.");
          return;
        }
        throw new Error(payload?.message || `Request failed (${res.status})`);
      }
      // On success, store auth token and redirect (robust handling)
      let payload: any = {};
      try { payload = await res.json(); } catch {}
      let token = payload?.token || payload?.jwt || payload?.accessToken;

      // Fallback: try Authorization header (e.g., "Bearer <token>")
      if (!token) {
        const auth = res.headers.get("authorization") || res.headers.get("Authorization");
        if (auth && /^Bearer\s+/.test(auth)) token = auth.replace(/^Bearer\s+/i, "");
      }

      if (token) {
        try { localStorage.setItem("sla_token", token); } catch {}
      }
      if (payload?.user) {
        try { localStorage.setItem("sla_user", JSON.stringify(payload.user)); } catch {}
      }
      setNotice("Logged in! Redirecting…");
      // Navigate even if token parsing fails, to help diagnose guard issues
      setTimeout(() => {
        window.location.assign("/portal/dashboard");
      }, 10);
    } catch (err: any) {
      setError(err?.message || "Invalid OTP. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const onPasteOtp = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, OTP_LENGTH);
    if (text.length) {
      e.preventDefault();
      const next = Array.from({ length: OTP_LENGTH }, (_, i) => text[i] || "");
      setOtp(next);
      const idx = Math.min(text.length, OTP_LENGTH - 1);
      requestAnimationFrame(() => otpRefs.current[idx]?.focus());
    }
  };

  const updateOtp = (idx: number, val: string) => {
    if (!/^[0-9]?$/.test(val)) return;
    const next = [...otp];
    next[idx] = val;
    setOtp(next);
    if (val && idx < OTP_LENGTH - 1) {
      otpRefs.current[idx + 1]?.focus();
    }
  };

  const onOtpKeyDown = (idx: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Backspace" && !otp[idx] && idx > 0) {
      otpRefs.current[idx - 1]?.focus();
    }
    if (e.key === "ArrowLeft" && idx > 0) otpRefs.current[idx - 1]?.focus();
    if (e.key === "ArrowRight" && idx < OTP_LENGTH - 1) otpRefs.current[idx + 1]?.focus();
    if (e.key === "Enter") onVerify();
  };

  const canSend = PHONE_REGEX.test(phone.trim()) && !loading;
  const canVerify = otp.every((d) => d) && !loading;

  return (
    <div className="sla-login-root">
      <div className="sla-bg" aria-hidden />
      <div className="sla-card" role="main">
        <div
          className="sla-logo-center"
          style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 200, marginBottom: 16 }}
        >
          <img
            src="/sla-icon.png"
            alt="Sri Lakshmi Agro"
            className="sla-logo"
            width={200}
            height={200}
            loading="eager"
            decoding="async"
            fetchPriority="high"
            style={{ width: 200, height: 200, display: 'block' }}
          />
        </div>
        
        <p className="sla-sub">Secure sign‑in with OTP</p>

        {error && (
          <div className="sla-alert error" role="alert">
            <span aria-hidden>⚠️</span> {error}
          </div>
        )}
        {notice && (
          <div className="sla-alert info" role="status">
            <span aria-hidden>✅</span> {notice}
          </div>
        )}

        {step === "phone" && (
          <form onSubmit={onSendOtp} className="sla-form" aria-label="Phone login">
            <label className="sla-label" htmlFor="pre-phone">Mobile Number</label>
            <div className="sla-input-wrap">
              <span className="sla-prefix">+91</span>
              <input
                id="pre-phone"
                inputMode="tel"
                autoComplete="tel"
                placeholder="9876543210"
                value={phone}
                onChange={(e) => setPhone(e.target.value.replace(/\s/g, ""))}
                className="sla-input"
                aria-invalid={!!error}
              />
            </div>
            <button type="submit" className={classNames("sla-btn", canSend ? "" : "disabled")}
              disabled={!canSend}
            >{loading ? "Sending…" : "Send OTP"}</button>
            <p className="sla-tiny">By continuing, you agree to our terms & privacy policy.</p>
          </form>
        )}

        {step === "otp" && (
          <section className="sla-form" aria-label="Enter OTP">
            <div className="sla-row space">
              <div>
                <div className="sla-label">Enter OTP</div>
                <div className="sla-muted">Sent to <strong>{formattedPhone}</strong></div>
              </div>
              <button
                className={classNames("sla-link", secondsLeft > 0 && "disabled")}
                onClick={onSendOtp}
                disabled={secondsLeft > 0 || loading}
                aria-disabled={secondsLeft > 0}
                aria-label={secondsLeft > 0 ? `Resend available in ${secondsLeft}s` : "Resend OTP"}
              >
                {secondsLeft > 0 ? `Resend in ${secondsLeft}s` : "Resend OTP"}
              </button>
            </div>

            <div className="otp-grid" onPaste={onPasteOtp}>
              {otp.map((digit, i) => (
                <input
                  key={i}
                  ref={(el) => { if (el) otpRefs.current[i] = el; }}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  maxLength={1}
                  className="otp-box"
                  value={digit}
                  onChange={(e) => updateOtp(i, e.target.value.trim())}
                  onKeyDown={(e) => onOtpKeyDown(i, e)}
                  aria-label={`Digit ${i + 1}`}
                />
              ))}
            </div>

            <button className={classNames("sla-btn", canVerify ? "" : "disabled")} onClick={onVerify} disabled={!canVerify}>
              {loading ? "Verifying…" : "Verify & Sign In"}
            </button>
            <button className="sla-link" onClick={() => { setStep("phone"); setOtp(Array.from({ length: OTP_LENGTH }, () => "")); setError(null); }}>Use a different number</button>
          </section>
        )}

        <footer className="sla-footer">
          <div className="sla-tn">© {new Date().getFullYear()} Sri Lakshmi Agro • All rights reserved</div>
        </footer>
      </div>

      {/* Inline styles to keep the page self-contained */}
      <style>
        {`
        :root { --card-bg: rgba(255,255,255,0.75); --text: #0b1220; --muted: #5b6475; --ring: #5b8a2e; --accent: #7fbf3f; --accent-2: #4e9f3d; --error: #c0392b; --info: #2563eb; }
        @media (prefers-color-scheme: dark) {
          :root { --card-bg: rgba(13,17,23,0.75); --text: #e6edf3; --muted: #9aa4b2; --ring: #9bd35a; --accent: #a8e063; --accent-2: #7cc957; --info: #60a5fa; }
          body { background: #0b0f15; }
        }
        .sla-login-root { min-height: 100dvh; display: grid; place-items: center; background: radial-gradient(1200px 800px at 10% 10%, #eaffd9 0%, transparent 60%), radial-gradient(1200px 800px at 90% 90%, #d6ffe7 0%, transparent 60%); position: relative; overflow: hidden; }
        .sla-bg { position: absolute; inset: -20%; background: conic-gradient(from 200deg at 50% 50%, rgba(126,217,87,0.25), rgba(0,0,0,0) 35%, rgba(112,197,210,0.2), rgba(0,0,0,0) 70%, rgba(126,217,87,0.25)); filter: blur(60px); animation: swirl 18s linear infinite; }
        @keyframes swirl { to { transform: rotate(360deg); } }

        /* Reduce motion & pause animated bg while focusing inputs to avoid flicker */
        @media (prefers-reduced-motion: reduce) { .sla-bg { animation: none !important; } }
        .sla-login-root:focus-within .sla-bg { animation-play-state: paused; opacity: 0.9; }

        body, .sla-card, .sla-title { font-family: 'Poppins', 'Segoe UI', Roboto, system-ui, -apple-system, sans-serif; }

        .sla-card { position: relative; width: min(92vw, 440px); backdrop-filter: blur(16px) saturate(120%); background: var(--card-bg); border: 1px solid rgba(255,255,255,0.35); border-radius: 20px; padding: 28px 24px; box-shadow: 0 20px 60px rgba(0,0,0,0.15); z-index: 1; transform: translateZ(0); will-change: transform; backface-visibility: hidden; }
        .sla-logo-center { display: flex; justify-content: center; margin-bottom: 16px; }
        .sla-logo { width: 200px; height: 200px; object-fit: contain; display: block; }
        .sla-sub { margin: 0 0 16px; color: var(--muted); font-size: 16px; font-weight: 600; }

        .sla-alert { display: flex; gap: 8px; align-items: center; padding: 10px 12px; border-radius: 12px; font-size: 13px; margin: 8px 0 10px; }
        .sla-alert.error { background: rgba(192,57,43,0.08); color: #c0392b; border: 1px solid rgba(192,57,43,0.25); }
        .sla-alert.info { background: rgba(37,99,235,0.08); color: var(--info); border: 1px solid rgba(37,99,235,0.25); }
        .sla-alert.warn { background: rgba(245, 158, 11, 0.10); color: #b45309; border: 1px solid rgba(245, 158, 11, 0.35); }

        .sla-form { margin-top: 10px; display: grid; gap: 14px; }
        .sla-label { color: var(--muted); font-size: 13px; font-weight: 600; }
        .sla-input-wrap { position: relative; display: flex; align-items: center; }
        .sla-prefix { position: absolute; left: 12px; color: var(--muted); font-weight: 700; font-size: 14px; }
        .sla-input { width: 100%; padding: 14px 12px 14px 48px; border-radius: 14px; border: 1px solid rgba(0,0,0,0.12); outline: none; font-size: 16px; background: rgba(255,255,255,0.75); color: var(--text); caret-color: var(--text); transition: box-shadow .2s,border-color .2s, background .2s; }
        .sla-input::placeholder { color: rgba(11, 18, 32, 0.38); opacity: 1; }
        .sla-input:focus { border-color: var(--ring); box-shadow: 0 0 0 4px rgba(123, 200, 70, 0.20); background: rgba(255,255,255,0.9); }
        @media (prefers-color-scheme: dark) { .sla-input { background: rgba(22,27,34,0.6); border-color: rgba(255,255,255,0.12); } .sla-input:focus { background: rgba(22,27,34,0.85); } .sla-input::placeholder { color: rgba(230, 237, 243, 0.50); opacity: 1; } }

        .sla-btn { appearance: none; border: none; border-radius: 14px; padding: 14px 16px; font-size: 16px; font-weight: 800; letter-spacing: .2px; background: linear-gradient(180deg, var(--accent) 0%, var(--accent-2) 100%); color: #0b1a05; cursor: pointer; box-shadow: 0 10px 24px rgba(79, 176, 75, 0.35); transition: transform .06s ease, filter .2s ease, box-shadow .2s ease; }
        .sla-btn:hover { filter: brightness(1.03); }
        .sla-btn:active { transform: translateY(1px); }
        .sla-btn.disabled, .sla-btn:disabled { filter: grayscale(0.4) brightness(0.9); cursor: not-allowed; box-shadow: none; opacity: 0.75; }

        .sla-tiny { text-align: center; color: var(--muted); font-size: 12px; }
        .sla-link { background: none; border: none; color: var(--info); font-weight: 700; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; font-size: 14px; }
        .sla-link.disabled, .sla-link:disabled { opacity: .6; cursor: not-allowed; text-decoration: none; }

        .sla-row { display: flex; align-items: center; justify-content: space-between; }
        .sla-row.space { gap: 12px; }

        .otp-grid { display: grid; grid-template-columns: repeat(6, 52px); justify-content: center; gap: 12px; }
        .otp-box { width: 52px; height: 56px; text-align: center; font-size: 24px; padding: 0; border-radius: 12px; border: 1px solid rgba(0,0,0,0.12); background: rgba(255,255,255,0.75); color: var(--text); outline: none; transition: box-shadow .2s,border-color .2s, background .2s; }
        .otp-box:focus { border-color: var(--ring); box-shadow: 0 0 0 4px rgba(123, 200, 70, 0.20); background: rgba(255,255,255,0.9); }
        @media (prefers-color-scheme: dark) { .otp-box { background: rgba(22,27,34,0.6); border-color: rgba(255,255,255,0.12); } .otp-box:focus { background: rgba(22,27,34,0.85); } }

        .sla-footer { margin-top: 16px; display: grid; place-items: center; }
        .sla-muted { color: var(--muted); font-size: 13px; }
        .sla-tn { color: var(--muted); font-size: 12px; }
        `}
      </style>
    </div>
  );
};

export default Login;
