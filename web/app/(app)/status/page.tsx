import type { Metadata } from "next";
import { AppPage, Card, StatusPill } from "@/components/ds";
import { statusChecks } from "@/lib/server/status";

export const metadata: Metadata = { title: "Status" };
export const dynamic = "force-dynamic";

/** Each Google service this server uses, checked live. */
export default async function StatusPage() {
  const checks = await statusChecks();
  return (
    <AppPage title="Status" description={`${checks.filter((c) => c.ok).length} of ${checks.length} Google services configured and reachable from this server.`}>
      <Card>
        {checks.map((c) => (
          <div key={c.key} className="flex flex-wrap items-center gap-3 border-b border-divider py-2.5 last:border-0">
            <StatusPill kind={c.ok ? "licensed" : "revoked"}>{c.ok ? "configured" : "not configured"}</StatusPill>
            <b>{c.name}</b>
            <span className="text-[14px] text-grey">{c.detail}</span>
          </div>
        ))}
      </Card>
    </AppPage>
  );
}
