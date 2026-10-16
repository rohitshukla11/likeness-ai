"use client";
import { useCallback, useEffect, useState } from "react";
import { api, reason } from "@/lib/client/firebase";
import type { LicenceDoc, LicenceStatus, RequestDoc } from "@/lib/model";

export type LicenceRow = LicenceDoc & { status: LicenceStatus };
export type Render = {
  id: string;
  licenceId: string;
  brandId: string;
  creatorId: string;
  type: "image" | "video";
  renderIndex: number;
  sha256: string;
  mime: string;
  model: string;
  price: number;
  creatorShare: number;
  fee: number;
  brief: string;
  createdAt: number;
  pipeline?: string;
};
export type Lists = {
  asCreator: { requests: RequestDoc[]; licences: LicenceRow[] };
  asBrand: { requests: RequestDoc[]; licences: LicenceRow[] };
};

/** Load a JSON endpoint and reload on demand. */
export function useApi<T>(url: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    if (!url) return;
    try {
      setData(await api<T>(url));
      setError(null);
    } catch (e) {
      setError(reason(e));
    }
  }, [url]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, reload: load };
}

/** Open a render through a short-lived signed URL. */
export async function openRender(id: string) {
  const r = await api<{ url: string }>(`/api/renders/${id}/url`);
  window.open(r.url, "_blank", "noopener");
}

export const when = (ms: number) => new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
