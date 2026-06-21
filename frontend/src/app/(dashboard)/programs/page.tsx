'use client';
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { programs as programsApi, clearToken, Program } from '@/lib/api';

type EditState = { id: string; title: string; description: string; tags: string } | null;

export default function ProgramsPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ title: '', description: '', tags: '' });
  const [editing, setEditing] = useState<EditState>(null);

  const { data, isLoading, error } = useQuery({
    queryKey: ['programs'],
    queryFn: programsApi.list,
  });

  const createMutation = useMutation({
    mutationFn: (d: { title: string; description: string; tags: string[] }) =>
      programsApi.create(d),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['programs'] });
      setShowCreate(false);
      setForm({ title: '', description: '', tags: '' });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...d }: { id: string; title: string; description: string; tags: string[] }) =>
      programsApi.update(id, d),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['programs'] });
      setEditing(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => programsApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['programs'] }),
  });

  function handleLogout() {
    clearToken();
    router.push('/login');
  }

  function startEdit(p: Program) {
    setEditing({ id: p.id, title: p.title, description: p.description ?? '', tags: p.tags.join(', ') });
  }

  if (error) {
    if ((error as { status?: number }).status === 401) {
      clearToken();
      router.push('/login');
      return null;
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b px-6 py-4 flex items-center justify-between">
        <span className="text-lg font-semibold text-teal-700">Wellspring</span>
        <div className="flex items-center gap-4">
          <Link href="/audit" className="text-sm text-gray-500 hover:text-gray-700">
            Audit Log
          </Link>
          <button onClick={handleLogout} className="text-sm text-gray-500 hover:text-gray-700">
            Sign out
          </button>
        </div>
      </nav>

      <main className="max-w-4xl mx-auto px-6 py-8">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold text-gray-900">Programs</h1>
          <button
            onClick={() => setShowCreate(true)}
            className="bg-teal-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-teal-700"
          >
            New program
          </button>
        </div>

        {showCreate && (
          <div className="bg-white rounded-xl border p-6 mb-6 shadow-sm">
            <h2 className="text-base font-medium text-gray-900 mb-4">Create program</h2>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                createMutation.mutate({
                  title: form.title,
                  description: form.description,
                  tags: form.tags.split(',').map((t) => t.trim()).filter(Boolean),
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
              <textarea
                placeholder="Description (optional)"
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                rows={2}
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 resize-none"
              />
              <input
                placeholder="Tags (comma-separated)"
                value={form.tags}
                onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
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
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <div key={i} className="h-16 bg-gray-200 rounded-xl animate-pulse" />
            ))}
          </div>
        ) : data?.length === 0 ? (
          <p className="text-gray-400 text-sm text-center py-16">
            No programs yet. Create your first one.
          </p>
        ) : (
          <div className="space-y-3">
            {data?.map((p: Program) =>
              editing?.id === p.id ? (
                <div key={p.id} className="bg-white rounded-xl border p-5 shadow-sm">
                  <h2 className="text-sm font-medium text-gray-700 mb-3">Edit program</h2>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      updateMutation.mutate({
                        id: editing.id,
                        title: editing.title,
                        description: editing.description,
                        tags: editing.tags.split(',').map((t) => t.trim()).filter(Boolean),
                      });
                    }}
                    className="space-y-3"
                  >
                    <input
                      required
                      value={editing.title}
                      onChange={(e) => setEditing((f) => f && ({ ...f, title: e.target.value }))}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                    />
                    <textarea
                      value={editing.description}
                      onChange={(e) => setEditing((f) => f && ({ ...f, description: e.target.value }))}
                      rows={2}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500 resize-none"
                    />
                    <input
                      placeholder="Tags (comma-separated)"
                      value={editing.tags}
                      onChange={(e) => setEditing((f) => f && ({ ...f, tags: e.target.value }))}
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
                    />
                    {updateMutation.error && (
                      <p className="text-sm text-red-600">{(updateMutation.error as Error).message}</p>
                    )}
                    <div className="flex gap-2">
                      <button
                        type="submit"
                        disabled={updateMutation.isPending}
                        className="bg-teal-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-teal-700 disabled:opacity-50"
                      >
                        {updateMutation.isPending ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditing(null)}
                        className="text-sm text-gray-500 px-4 py-2 hover:text-gray-700"
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                </div>
              ) : (
                <div
                  key={p.id}
                  className="bg-white rounded-xl border p-5 flex items-center justify-between shadow-sm hover:shadow-md transition-shadow"
                >
                  <div>
                    <Link
                      href={`/programs/${p.id}/sessions`}
                      className="font-medium text-gray-900 hover:text-teal-600"
                    >
                      {p.title}
                    </Link>
                    {p.description && (
                      <p className="text-sm text-gray-400 mt-0.5 line-clamp-1">{p.description}</p>
                    )}
                    {p.tags.length > 0 && (
                      <div className="flex gap-1 mt-1">
                        {p.tags.map((t) => (
                          <span key={t} className="text-xs bg-teal-50 text-teal-700 px-2 py-0.5 rounded-full">
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-3 ml-4">
                    <button
                      onClick={() => startEdit(p)}
                      className="text-sm text-gray-400 hover:text-gray-700"
                    >
                      Edit
                    </button>
                    <Link
                      href={`/programs/${p.id}/import`}
                      className="text-sm text-gray-400 hover:text-gray-700"
                    >
                      Import CSV
                    </Link>
                    <button
                      onClick={() => deleteMutation.mutate(p.id)}
                      disabled={deleteMutation.isPending}
                      className="text-sm text-red-400 hover:text-red-600"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )
            )}
          </div>
        )}
      </main>
    </div>
  );
}
