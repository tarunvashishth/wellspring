'use client';
import { useState, useRef } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { uploads } from '@/lib/api';

type UploadState = 'idle' | 'uploading' | 'completing' | 'done' | 'error';

export default function UploadPage() {
  const { id: programId } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const sessionId = searchParams.get('session') ?? '';
  const router = useRouter();

  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<UploadState>('idle');
  const [progress, setProgress] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const xhrRef = useRef<XMLHttpRequest | null>(null);

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) {
      setFile(f);
      setState('idle');
      setErrorMsg('');
      setProgress(0);
    }
  }

  async function handleUpload() {
    if (!file || !sessionId) return;
    setState('uploading');
    setErrorMsg('');
    setProgress(0);

    try {
      // 1. Get presigned POST URL
      const { uploadUrl, fields, uploadKey } = await uploads.initiate({
        sessionId,
        contentType: file.type,
        filename: file.name,
      });

      // 2. Upload directly to S3 with XHR for progress tracking
      await new Promise<void>((resolve, reject) => {
        const formData = new FormData();
        Object.entries(fields).forEach(([k, v]) => formData.append(k, v));
        formData.append('file', file);

        const xhr = new XMLHttpRequest();
        xhrRef.current = xhr;

        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            setProgress(Math.round((e.loaded / e.total) * 100));
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(new Error(`S3 upload failed: ${xhr.status}`));
          }
        };

        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.open('POST', uploadUrl);
        xhr.send(formData);
      });

      // 3. Notify backend to verify and mark session VERIFIED
      setState('completing');
      await uploads.complete({ sessionId, uploadKey });
      setState('done');

      setTimeout(() => router.push(`/programs/${programId}/sessions`), 1500);
    } catch (err) {
      setState('error');
      setErrorMsg((err as Error).message || 'Upload failed');
    }
  }

  function handleCancel() {
    xhrRef.current?.abort();
    setState('idle');
    setProgress(0);
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b px-6 py-4 flex items-center gap-3">
        <Link href={`/programs/${programId}/sessions`} className="text-sm text-gray-500 hover:text-gray-700">
          ← Sessions
        </Link>
        <span className="text-gray-300">/</span>
        <span className="text-sm font-medium text-gray-900">Upload media</span>
      </nav>

      <main className="max-w-lg mx-auto px-6 py-12">
        <h1 className="text-2xl font-semibold text-gray-900 mb-2">Upload media</h1>
        <p className="text-sm text-gray-500 mb-8">
          Supported formats: MP4, WebM, MOV, MP3, AAC, WAV, OGG, FLAC
        </p>

        <div
          className="border-2 border-dashed border-gray-200 rounded-xl p-10 text-center cursor-pointer hover:border-teal-400 transition-colors"
          onClick={() => document.getElementById('file-input')?.click()}
        >
          <input
            id="file-input"
            type="file"
            className="hidden"
            accept="video/*,audio/*"
            onChange={handleFileChange}
          />
          {file ? (
            <div>
              <p className="font-medium text-gray-800">{file.name}</p>
              <p className="text-sm text-gray-400 mt-1">
                {(file.size / 1_048_576).toFixed(1)} MB
              </p>
            </div>
          ) : (
            <div>
              <p className="text-gray-400">Click to choose a file</p>
              <p className="text-xs text-gray-300 mt-1">Max 500 MB</p>
            </div>
          )}
        </div>

        {file && state === 'idle' && (
          <button
            onClick={handleUpload}
            className="mt-6 w-full bg-teal-600 text-white rounded-lg py-3 text-sm font-medium hover:bg-teal-700"
          >
            Upload
          </button>
        )}

        {state === 'uploading' && (
          <div className="mt-6">
            <div className="flex items-center justify-between text-sm text-gray-600 mb-2">
              <span>Uploading…</span>
              <span>{progress}%</span>
            </div>
            <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-teal-500 transition-all"
                style={{ width: `${progress}%` }}
              />
            </div>
            <button
              onClick={handleCancel}
              className="mt-3 text-sm text-red-400 hover:text-red-600"
            >
              Cancel
            </button>
          </div>
        )}

        {state === 'completing' && (
          <p className="mt-6 text-sm text-gray-500 text-center">Verifying content…</p>
        )}

        {state === 'done' && (
          <div className="mt-6 bg-green-50 text-green-700 rounded-lg p-4 text-sm text-center font-medium">
            Upload verified! Redirecting…
          </div>
        )}

        {state === 'error' && (
          <div className="mt-6 bg-red-50 text-red-600 rounded-lg p-4 text-sm">
            {errorMsg}
            <button
              onClick={() => { setState('idle'); setProgress(0); }}
              className="ml-3 underline"
            >
              Try again
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
