"use client";
import Link from "next/link";
import { useState } from "react";
import { Card, StatCard, pillClass } from "@/components/ds";
import { StatusBadge, inputClass } from "@/components/ui";
import type { Me } from "@/components/auth/AuthProvider";
import { api, reason } from "@/lib/client/firebase";
import { credits, DEMO_TOPUP, useLabel } from "@/lib/model";
import { openRender, useApi, when, type LicenceRow, type Lists, type Render } from "./shared";

export function BrandDashboard({ me, refresh }: { me: Me; refresh: () => Promise<void> }) {
  const lists = useApi<Lists>("/api/licences");
  const renders = useApi<{ asBrand: Render[] }>("/api/renders");
  const [msg, setMsg] = useState<string | null>(null);
  const [name, setName] = useState(me.brand?.name ?? "");
  const [site, setSite] = useState(me.brand?.website ?? "");

  if (!me.brand)
    return (
      <Card title="Set up your brand">
        <label className="flex flex-col gap-1 text-[14px]">
          <span className="text-grey">Brand name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputClass} placeholder="Brew & Co." />
        </label>
        <label className="flex flex-col gap-1 text-[14px]">
          <span className="text-grey">Website (optional)</span>
          <input value={site} onChange={(e) => setSite(e.target.value)} className={inputClass} placeholder="brewandco.example" />
        </label>
        <button type="button" onClick={() => api("/api/brand", { method: "POST", body: JSON.stringify({ name, website: site }) }).then(refresh).catch((e) => setMsg(reason(e)))} className={pillClass("ink", "self-start")}>
          Save brand
        </button>
        {msg && <span className="text-bad">{msg}</span>}
      </Card>
    );

  const licences = lists.data?.asBrand.licences ?? [];
  const pending = (lists.data?.asBrand.requests ?? []).filter((r) => r.state === "pending");
  return (
    <div className="flex flex-col gap-[18px]">
      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="Demo credits" value={credits(me.credits)} note="demo money for the prototype, not real payments" />
        <StatCard label="Active licences" value={licences.filter((l) => l.status === "Active").length} note={`${pending.length} request${pending.length === 1 ? "" : "s"} waiting for the creator`} />
        <Card tone="lime">
          <span className="text-[14px] font-semibold">{me.brand.name}</span>
          <button
            type="button"
            onClick={() =>
              api("/api/credits/topup", { method: "POST" })
                .then(() => (setMsg(`Added ${DEMO_TOPUP} demo credits.`), refresh()))
                .catch((e) => setMsg(reason(e)))
            }
            className={pillClass("ink", "self-start")}
          >
            Top up {DEMO_TOPUP} demo credits
          </button>
        </Card>
      </div>
      {msg && <p role="status" className="m-0 text-[15px] text-wait">{msg}</p>}

      <Card title="Licences" action={<Link href="/creators" className={pillClass("outline", "min-h-10 px-4")}>Find a creator</Link>}>
        {licences.length === 0 && pending.length === 0 && <p className="m-0 text-grey">No licences yet. Request one from a creator&apos;s page.</p>}
        {pending.map((r) => (
          <span key={r.id} className="text-[14px] text-wait">
            Waiting for approval: {useLabel(r.use)}, {r.maxRenders} renders, {r.days} days
          </span>
        ))}
        {licences.map((l) => (
          <LicenceCard key={l.id} l={l} onRendered={async () => Promise.all([lists.reload(), renders.reload(), refresh()]).then(() => {})} />
        ))}
      </Card>

      <Card title="Your renders">
        {(renders.data?.asBrand ?? []).length === 0 && <p className="m-0 text-grey">None yet.</p>}
        {(renders.data?.asBrand ?? []).map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-3 border-b border-divider py-2 last:border-0">
            <span className="font-semibold">{r.type === "video" ? "Video" : "Image"}</span>
            <span className="text-grey">
              {when(r.createdAt)} · {r.price} credits · {r.model}
              {r.pipeline ? ` · ${r.pipeline}` : ""}
            </span>
            <button type="button" onClick={() => openRender(r.id).catch((e) => setMsg(reason(e)))} className={pillClass("outline", "ml-auto min-h-10 px-4")}>
              Download
            </button>
          </div>
        ))}
      </Card>
    </div>
  );
}

function LicenceCard({ l, onRendered }: { l: LicenceRow; onRendered: () => Promise<void> }) {
  const [brief, setBrief] = useState("Smiling in a sunlit café holding a ceramic coffee cup, product shot for a spring campaign");
  const [aspect, setAspect] = useState<"1:1" | "16:9" | "9:16">("1:1");
  const [busy, setBusy] = useState<string | null>(null);
  const [out, setOut] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const image = async () => {
    setBusy("Checking the brief, opening the photos for this render, generating with Gemini, signing…");
    setErr(null);
    setOut(null);
    try {
      const r = await api<{ render: { id: string; price: number } }>("/api/render/image", { method: "POST", body: JSON.stringify({ licenceId: l.id, brief, aspectRatio: aspect }) });
      setOut(`Image ad ready: ${r.render.price} credits paid.`);
      await onRendered();
      await openRender(r.render.id);
    } catch (e) {
      setErr(reason(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-col gap-2 rounded-[14px] bg-paper p-3">
      <span className="flex flex-wrap items-center gap-3">
        <StatusBadge status={l.status} />
        <b>{l.creatorName}</b>
        <span className="text-grey">
          {useLabel(l.use)} · {l.renderCount}/{l.maxRenders} renders · image {l.pricePerImage} · video {l.pricePerVideo} credits · until {when(l.end)}
        </span>
      </span>
      {l.status === "Active" && (
        <>
          <label className="flex flex-col gap-1 text-[14px]">
            <span className="text-grey">Brief</span>
            <textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={2} className={`${inputClass} py-2`} />
          </label>
          <span className="flex flex-wrap items-center gap-2">
            {(["1:1", "16:9", "9:16"] as const).map((a) => (
              <button key={a} type="button" aria-pressed={aspect === a} onClick={() => setAspect(a)} className={pillClass(aspect === a ? "ink" : "outline", "min-h-9 px-3 text-[13px]")}>
                {a}
              </button>
            ))}
            <button type="button" disabled={!!busy} onClick={image} className={pillClass("lime", "min-h-10 px-4")}>
              Make an image ad ({l.pricePerImage} credits)
            </button>
          </span>
        </>
      )}
      {busy && <span className="text-[14px] text-wait">{busy}</span>}
      {out && <span className="text-[14px] text-ok">{out}</span>}
      {err && <span role="alert" className="text-[14px] text-bad">{err}</span>}
    </div>
  );
}
