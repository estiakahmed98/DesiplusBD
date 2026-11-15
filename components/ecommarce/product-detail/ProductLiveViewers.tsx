"use client";

import { useEffect, useState } from "react";
import { Eye } from "lucide-react";
import { useTranslations } from "next-intl";

const BASE_MIN = 10;
const BASE_MAX = 50;
const HEARTBEAT_MS = 15_000;
const VISITOR_KEY = "product-viewer-id";

const randomInt = (min: number, max: number) =>
  min + Math.floor(Math.random() * (max - min + 1));

function getVisitorId() {
  try {
    const existing = localStorage.getItem(VISITOR_KEY);
    if (existing) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(VISITOR_KEY, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

// Next value: usually a small drift, sometimes a bigger jump (e.g. 32 → 36 → 25).
function nextBase(current: number) {
  if (Math.random() < 0.2) return randomInt(BASE_MIN, BASE_MAX);
  const step = randomInt(1, 6) * (Math.random() < 0.5 ? -1 : 1);
  return Math.min(BASE_MAX, Math.max(BASE_MIN, current + step));
}

export default function ProductLiveViewers({ productId }: { productId: number }) {
  const t = useTranslations("StorefrontProduct.purchase");
  // Random values are created only on the client to avoid hydration mismatch.
  const [base, setBase] = useState<number | null>(null);
  const [realViewers, setRealViewers] = useState(0);

  useEffect(() => {
    setBase(randomInt(BASE_MIN, BASE_MAX));
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        setBase((current) => nextBase(current ?? randomInt(BASE_MIN, BASE_MAX)));
        schedule();
      }, randomInt(2000, 3000));
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    const visitorId = getVisitorId();
    const url = `/api/product-viewers/${productId}`;
    let cancelled = false;

    const beat = async () => {
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ visitorId }),
          cache: "no-store",
        });
        if (!response.ok) return;
        const data = (await response.json()) as { viewers?: number };
        if (!cancelled && typeof data.viewers === "number") setRealViewers(data.viewers);
      } catch {
        // Network hiccups only affect the real-viewer part of the number.
      }
    };

    beat();
    const interval = setInterval(beat, HEARTBEAT_MS);
    const leave = () => {
      navigator.sendBeacon?.(
        url,
        new Blob([JSON.stringify({ visitorId, leave: true })], { type: "application/json" }),
      );
    };
    window.addEventListener("pagehide", leave);
    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [productId]);

  if (base === null) return null;

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded bg-white/95 px-2.5 py-1 text-[11px] font-semibold text-slate-700 shadow-sm ring-1 ring-slate-200"
      aria-live="off"
    >
      <span className="relative flex size-2">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-red-400 opacity-75 motion-reduce:hidden" />
        <span className="relative inline-flex size-2 rounded-full bg-red-500" />
      </span>
      <Eye className="size-3.5" aria-hidden="true" />
      <span className="tabular-nums">{t("liveViewers", { count: base + realViewers })}</span>
    </span>
  );
}
