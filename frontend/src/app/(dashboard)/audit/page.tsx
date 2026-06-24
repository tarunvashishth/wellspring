'use client';
import { Suspense, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import Link from 'next/link';
import { audit, AuditLog } from '@/lib/api';

const ACTIONS = [
  'program.create', 'program.update', 'program.delete',
  'session.create', 'session.update', 'session.delete', 'session.reorder',
  'import.start', 'import.complete',
  'upload.initiate', 'upload.complete', 'upload.fail',
  'creator.signup', 'creator.login', 'creator.logout',
];

const SEVERITY_BADGE: Record<string, string> = {
  info: 'bg-blue-50 text-blue-600',
  warn: 'bg-yellow-50 text-yellow-700',
  critical: 'bg-red-50 text-red-600',
};

function AuditContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Filters are stored in the URL query string (?action=program.create&severity=warn) rather
  // than in React state. This makes the filtered view shareable/bookmarkable and preserves
  // filters on browser back navigation — no state lost on refresh.
  function updateFilter(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key); // remove the param entirely if value is empty (show all)
    router.replace(`${pathname}?${params.toString()}`); // replace so back button skips filter changes
  }

  const filters = {
    action: searchParams.get('action') ?? '',
    severity: searchParams.get('severity') ?? '',
    from: searchParams.get('from') ?? '',
    to: searchParams.get('to') ?? '',
  };

  // Strip empty-string filters before passing to the API — backend ignores missing params.
  const queryParams = Object.fromEntries(
    Object.entries(filters).filter(([, v]) => v !== ''),
  );

  // useInfiniteQuery handles cursor-based pagination ("Load more" pattern).
  // Each page returns { items, nextCursor }. getNextPageParam extracts the cursor for the
  // next page. When the user clicks "Load more", fetchNextPage() sends the next request.
  // All pages are accumulated in data.pages; flatMap merges them into a single logs array.
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isLoading, error } =
    useInfiniteQuery({
      queryKey: ['audit', queryParams], // changing filters creates a new cache entry = new fetch
      queryFn: ({ pageParam }) =>
        audit.list({ ...queryParams, ...(pageParam ? { cursor: pageParam as string } : {}) }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (last) => last.nextCursor ?? undefined, // undefined means no more pages
    });

  // Flatten all fetched pages into one flat array for rendering.
  const logs = data?.pages.flatMap((p) => p.items) ?? [];

  if (error) {
    return <p className="text-red-500 text-sm">{(error as Error).message}</p>;
  }

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-6">
        <select
          value={filters.action}
          onChange={(e) => updateFilter('action', e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
        >
          <option value="">All actions</option>
          {ACTIONS.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>

        <select
          value={filters.severity}
          onChange={(e) => updateFilter('severity', e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
        >
          <option value="">All severities</option>
          <option value="info">Info</option>
          <option value="warn">Warn</option>
          <option value="critical">Critical</option>
        </select>

        <input
          type="date"
          value={filters.from}
          onChange={(e) => updateFilter('from', e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
        />
        <input
          type="date"
          value={filters.to}
          onChange={(e) => updateFilter('to', e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
        />
      </div>

      {/* Log table */}
      {isLoading ? (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-12 bg-gray-200 rounded-lg animate-pulse" />
          ))}
        </div>
      ) : logs.length === 0 ? (
        <p className="text-gray-400 text-sm text-center py-16">No audit logs found.</p>
      ) : (
        <>
          <div className="bg-white rounded-xl border overflow-hidden shadow-sm">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-gray-50">
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Time</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Action</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Target</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500">Severity</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log: AuditLog) => (
                  <tr key={log.id} className="border-b last:border-0 hover:bg-gray-50">
                    <td className="px-4 py-3 text-gray-400 whitespace-nowrap">
                      {new Date(log.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 font-mono text-gray-700">{log.action}</td>
                    <td className="px-4 py-3 text-gray-500">
                      {log.targetType}
                      {log.targetId && (
                        <span className="text-gray-300 ml-1 text-xs">
                          {log.targetId.slice(0, 8)}…
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          SEVERITY_BADGE[log.severity] ?? 'bg-gray-100 text-gray-500'
                        }`}
                      >
                        {log.severity}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {hasNextPage && (
            <div className="text-center mt-6">
              <button
                onClick={() => fetchNextPage()}
                disabled={isFetchingNextPage}
                className="text-sm text-teal-600 hover:text-teal-700 font-medium disabled:opacity-50"
              >
                {isFetchingNextPage ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function AuditPage() {
  const router = useRouter();

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b px-6 py-4 flex items-center gap-3">
        <Link href="/programs" className="text-sm text-gray-500 hover:text-gray-700">
          ← Programs
        </Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm font-medium text-gray-900">Audit Log</span>
      </nav>

      <main className="max-w-5xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-semibold text-gray-900 mb-6">Audit Log</h1>
        <Suspense fallback={<div className="h-8 bg-gray-200 rounded animate-pulse" />}>
          <AuditContent />
        </Suspense>
      </main>
    </div>
  );
}
