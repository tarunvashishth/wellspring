'use client';
import { useState, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { programs as programsApi, clearToken } from '@/lib/api';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface ImportRow {
  rowNumber: number;
  field?: string;
  message: string;
  rawData?: Record<string, string>;
}

interface ImportResult {
  importId: string;
  status: string;
  totalRows: number;
  successRows: number;
  failedRows: number;
  errors: ImportRow[];
}

function getToken() {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('token');
}

export default function ImportPage() {
  const { id: programId } = useParams<{ id: string }>();
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [clientImportId] = useState(() => crypto.randomUUID());
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: program } = useQuery({
    queryKey: ['program', programId],
    queryFn: () => programsApi.get(programId),
  });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;

    setLoading(true);
    setError(null);
    setResult(null);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('clientImportId', clientImportId);

    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/programs/${programId}/imports`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });

      if (res.status === 401) {
        clearToken();
        router.push('/login');
        return;
      }

      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Import failed');
        return;
      }
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b px-6 py-4 flex items-center gap-3">
        <Link href="/programs" className="text-sm text-gray-500 hover:text-gray-700">
          ← Programs
        </Link>
        <span className="text-gray-300">/</span>
        <Link
          href={`/programs/${programId}/sessions`}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          {program?.title ?? '…'}
        </Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm font-medium text-gray-900">Import CSV</span>
        <span className="ml-auto" />
        <button
          onClick={() => { clearToken(); router.push('/login'); }}
          className="text-sm text-gray-500 hover:text-gray-700"
        >
          Sign out
        </button>
      </nav>

      <main className="max-w-3xl mx-auto px-6 py-8">
        <h1 className="text-2xl font-semibold text-gray-900 mb-2">Import Sessions from CSV</h1>
        <p className="text-sm text-gray-500 mb-6">
          Upload a CSV file to bulk-import sessions into <strong>{program?.title}</strong>.
          The import is idempotent — re-uploading the same file will not create duplicates.
        </p>

        <div className="bg-white rounded-xl border p-6 shadow-sm mb-6">
          <h2 className="text-sm font-medium text-gray-700 mb-3">Expected CSV format</h2>
          <pre className="bg-gray-50 rounded-lg p-3 text-xs text-gray-600 overflow-x-auto">
{`title,description,instructor_name,tags,duration_seconds
"Sun Salutation","Opening flow","Alice Chen","yoga,morning",600
"Warrior Sequence","Strength building","Alice Chen","strength",900`}
          </pre>
          <p className="text-xs text-gray-400 mt-2">
            Required: <code>title</code>, <code>duration_seconds</code>.
            Optional: <code>description</code>, <code>instructor_name</code>, <code>tags</code> (comma-separated within quotes).
          </p>
        </div>

        <div className="bg-white rounded-xl border p-6 shadow-sm mb-6">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">CSV file</label>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-teal-50 file:text-teal-700 hover:file:bg-teal-100"
              />
            </div>
            <p className="text-xs text-gray-400">Import ID: <code>{clientImportId}</code> (stable for this page load — refresh to generate a new one)</p>
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button
              type="submit"
              disabled={!file || loading}
              className="bg-teal-600 text-white px-6 py-2 rounded-lg text-sm font-medium hover:bg-teal-700 disabled:opacity-50"
            >
              {loading ? 'Importing…' : 'Import'}
            </button>
          </form>
        </div>

        {result && (
          <div className="bg-white rounded-xl border p-6 shadow-sm">
            <h2 className="text-base font-medium text-gray-900 mb-4">Import result</h2>
            <div className="grid grid-cols-3 gap-4 mb-6">
              <div className="text-center">
                <p className="text-2xl font-semibold text-gray-900">{result.totalRows}</p>
                <p className="text-xs text-gray-400">Total rows</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-semibold text-green-600">{result.successRows}</p>
                <p className="text-xs text-gray-400">Imported</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-semibold text-red-500">{result.failedRows}</p>
                <p className="text-xs text-gray-400">Failed</p>
              </div>
            </div>

            <div className="mb-4">
              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                result.status === 'COMPLETED' ? 'bg-green-100 text-green-700' :
                result.status === 'PARTIAL' ? 'bg-yellow-100 text-yellow-700' :
                'bg-red-100 text-red-600'
              }`}>
                {result.status}
              </span>
            </div>

            {result.errors.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-gray-700 mb-2">
                  Row-level errors ({result.errors.length})
                </h3>
                <div className="space-y-2 max-h-96 overflow-y-auto">
                  {result.errors.map((err, i) => (
                    <div key={i} className="bg-red-50 rounded-lg p-3 text-xs">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-red-700">Row {err.rowNumber}</span>
                        {err.field && (
                          <span className="text-red-500">· field: <code>{err.field}</code></span>
                        )}
                      </div>
                      <p className="text-red-600">{err.message}</p>
                      {err.rawData && (
                        <pre className="mt-1 text-red-400 overflow-x-auto">
                          {JSON.stringify(err.rawData, null, 2)}
                        </pre>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {result.successRows > 0 && (
              <div className="mt-4">
                <Link
                  href={`/programs/${programId}/sessions`}
                  className="text-sm text-teal-600 hover:text-teal-700 font-medium"
                >
                  View sessions →
                </Link>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
