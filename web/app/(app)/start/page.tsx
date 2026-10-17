"use client";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppPage, Card, pillClass } from "@/components/ds";
import { useAuth } from "@/components/auth/AuthProvider";
import { api, reason, signIn, startDemoBrand } from "@/lib/client/firebase";

/** After sign-in: choose to be a creator or a brand (you can do both later). */
export default function StartPage() {
  const { user, me, loading, refresh } = useAuth();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (me?.user.role === "creator") router.replace(me.creator?.status === "live" ? "/dashboard" : "/creator/onboard");
    if (me?.user.role === "brand") router.replace("/dashboard");
  }, [me, router]);

  async function choose(role: "creator" | "brand") {
    setBusy(true);
    setErr(null);
    try {
      await api("/api/me", { method: "POST", body: JSON.stringify({ role }) });
      await refresh();
      router.push(role === "creator" ? "/creator/onboard" : "/dashboard");
    } catch (e) {
      setErr(reason(e));
    } finally {
      setBusy(false);
    }
  }

  async function demo() {
    setBusy(true);
    setErr(null);
    try {
      await startDemoBrand();
      await refresh();
      router.push("/dashboard");
    } catch (e) {
      setErr(reason(e));
      setBusy(false);
    }
  }

  if (!loading && !user)
    return (
      <AppPage title="Get started" description="Sign in with Google, or try the brand side first without an account.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Card title="Sign in with Google">
            <p className="m-0 text-[15px] text-grey">For creators and brands. Creators connect the YouTube channel on this Google account.</p>
            <button type="button" disabled={busy} onClick={() => signIn().catch((e) => setErr(reason(e)))} className={pillClass("ink", "mt-2 self-start")}>
              Sign in with Google
            </button>
          </Card>
          <Card title="Try as a demo brand">
            <p className="m-0 text-[15px] text-grey">
              No account needed. A temporary brand with 2,000 demo credits that can license our synthetic demo creators (approved instantly) and make up to 3
              real AI ads, one of them a video.
            </p>
            <button type="button" disabled={busy} onClick={demo} className={pillClass("lime", "mt-2 self-start")}>
              {busy ? "Starting…" : "Try as a demo brand"}
            </button>
          </Card>
        </div>
        {err && <p role="alert" className="m-0 text-bad">{err}</p>}
      </AppPage>
    );

  return (
    <AppPage title="How will you use Likeness?" description="Pick one to start. You can switch later.">
      <div className="grid gap-4 sm:grid-cols-2">
        <Card title="I'm a creator">
          <p className="m-0 text-[15px] text-grey">Connect your YouTube channel, take a quick live face check, and license your likeness for AI ads. You approve every brand and get paid per render.</p>
          <button type="button" disabled={busy} onClick={() => choose("creator")} className={pillClass("ink", "mt-2 self-start")}>
            Become a creator
          </button>
        </Card>
        <Card title="I'm a brand">
          <p className="m-0 text-[15px] text-grey">Request a licence from a verified creator, then make image and video ads in minutes, paid per render.</p>
          <button type="button" disabled={busy} onClick={() => choose("brand")} className={pillClass("lime", "mt-2 self-start")}>
            License a face
          </button>
        </Card>
      </div>
      {err && <p className="m-0 text-bad">{err}</p>}
    </AppPage>
  );
}
