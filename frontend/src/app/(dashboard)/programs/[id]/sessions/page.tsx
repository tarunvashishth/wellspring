'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { programs as programsApi, sessions as sessionsApi, clearToken, Session } from '@/lib/api';
import SessionList from '@/components/SessionList';

export default function SessionsPage() {
  const { id: programId } = useParams<{ id: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ title: '', description: '', durationSeconds: '' });

  const { data: program } = useQuery({
    queryKey: ['program', programId],
    queryFn: () => programsApi.get(programId),
  });

  const { data: sessionData, isLoading } = useQuery({
    queryKey: ['sessions', programId],
    queryFn: () => sessionsApi.list(programId),
  });

  const createMutation = useMutation({
    mutationFn: (d: { title: string; description: string; durationSeconds: number }) =>
      sessionsApi.create(programId, d),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sessions', programId] });
      setShowCreate(false);
      setForm({ title: '', description: '', durationSeconds: '' });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => sessionsApi.delete(programId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions', programId] }),
  });

  const reorderMutation = useMutation({
    mutationFn: (orderedIds: string[]) => sessionsApi.reorder(programId, orderedIds),
    onSuccess: (data) => {
      qc.setQueryData(['sessions', programId], data);
    },
  });

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b px-6 py-4 flex items-center gap-3">
        <Link href="/programs" className="text-sm text-gray-500 hover:text-gray-700">
          ← Programs
        </Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm font-medium text-gray-900">{program?.title ?? '…'}</span>
        <span className="ml-auto" />
        <Link href="/audit" className="text-sm text-gray-500 hover:text-gray-700">
          Audit Log
        </Link>
        <button
          onClick={() => { clearToken(); router.push('/login'); }}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          Sign out
        </button>
      </nav>

      <main className="max-w-3xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold text-gray-900">Sessions</h1>
          <button
            onClick={() => setShowCreate(true)}
            className="bg-teal-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-teal-700"
          >
            New session
          </button>
        </div>

        {showCreate && (
          <div className="bg-white rounded-xl border p-6 mb-6 shadow-sm">
            <h2 className="text-base font-medium text-gray-900 mb-4">Create session</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                createMutation.mutate({
                  title: form.title,
                  description: form.description,
                  durationSeconds: parseInt(form.durationSeconds, 10),
                });
              }}
              className="space-y-3"
            >
              <input
                required
                placeholder="Title"
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
              <input
                placeholder="Description (optional)"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
              <input
                required
                type="number"
                min={1}
                max={86400}
                placeholder="Duration (seconds)"
                value={form.durationSeconds}
                onChange={(e) => setForm((f) => ({ ...f, durationSeconds: e.target.value }))}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
              {createMutation.error && (
                <p className="text-sm text-red-600">{(createMutation.error as Error).message}</p>
              )}
              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={createMutation.isPending}
                  className="bg-teal-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-teal-700 disabled:opacity-50"
                >
                  {createMutation.isPending ? 'Creating…' : 'Create'}
                </button>
                <button
                  type="button"
                  onClick={() => setShowCreate(false)}
                  className="text-sm text-gray-500 px-4 py-2 hover:text-gray-700"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        )}

        {isLoading ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="h-16 bg-gray-200 rounded-xl animate-pulse" />
            ))}
          </div>
        ) : (
          <SessionList
            sessions={sessionData ?? []}
            onReorder={(ids) => reorderMutation.mutateAsync(ids)}
            onDelete={(id) => deleteMutation.mutate(id)}
            onUpload={(sessionId) => router.push(`/programs/${programId}/upload?session=${sessionId}`)}
          />
        )}
      </main>
    </div>
  );
}
