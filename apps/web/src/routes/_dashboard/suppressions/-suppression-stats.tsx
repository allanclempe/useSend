import { useQuery } from "@tanstack/react-query";

import { suppressionQueries } from "~/queries/suppression";

export default function SuppressionStats() {
  const { data: stats, isLoading } = useQuery(suppressionQueries.stats());

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-4 lg:gap-8">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="flex flex-col gap-2 rounded-lg border p-4 shadow"
          >
            <div className="mb-1 h-4 animate-pulse rounded bg-muted" />
            <div className="h-8 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
    );
  }

  const totalSuppressions = stats
    ? Object.values(stats).reduce((a, b) => a + b, 0)
    : 0;

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-6 lg:grid-cols-4 lg:gap-8">
      <div className="flex flex-col gap-2 rounded-lg border p-4 shadow">
        <p className="mb-1 font-semibold">Total Suppressions</p>
        <div className="font-mono text-2xl">{totalSuppressions}</div>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border p-4 shadow">
        <p className="mb-1 font-semibold">Hard Bounces</p>
        <div className="font-mono text-2xl text-red">
          {stats?.HARD_BOUNCE ?? 0}
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border p-4 shadow">
        <p className="mb-1 font-semibold">Complaints</p>
        <div className="font-mono text-2xl text-yellow">
          {stats?.COMPLAINT ?? 0}
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border p-4 shadow">
        <p className="mb-1 font-semibold">Manual</p>
        <div className="font-mono text-2xl text-blue">{stats?.MANUAL ?? 0}</div>
      </div>
    </div>
  );
}
