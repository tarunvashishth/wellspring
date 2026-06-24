'use client';
import { useState, useRef } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { uploads } from '@/lib/api';

// Union type for the upload state machine — only these values are allowed.
// Using a type union instead of booleans makes the UI logic easier to follow:
// each state maps directly to a distinct UI panel (progress bar, spinner, success, error).
type UploadState = 'idle' | 'uploading' | 'completing' | 'done' | 'error';

export default function UploadPage() {
  // programId comes from the URL segment /programs/[id]/upload
  const { id: programId } = useParams<{ id: string }>();
  // sessionId comes from the query string: /upload?session=<uuid>
  // The sessions page navigates here with the session ID in the URL.
  const searchParams = useSearchParams();
  const sessionId = searchParams.get('session') ?? '';
  const router = useRouter();

  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<UploadState>('idle');
  const [progress, setProgress] = useState(0);  // 0–100, for the progress bar
  const [errorMsg, setErrorMsg] = useState('');
  // useRef stores the XHR instance so handleCancel can call .abort() on it.
  // useRef doesn't trigger a re-render when changed (unlike useState) — right for this use case.
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
      // Step 1: Ask the backend for a pre-signed S3 URL.
      // The backend generates a time-limited permission slip (uploadUrl + fields)
      // that allows the browser to upload directly to S3.
      const { uploadUrl, fields, uploadKey } = await uploads.initiate({
        sessionId,
        contentType: file.type,
        filename: file.name,
      });

      // Step 2: Upload the file directly to S3 using XMLHttpRequest (XHR).
      // We use XHR instead of fetch because XHR has built-in upload progress events
      // (xhr.upload.onprogress). fetch does not support upload progress natively.
      // The formData must include all fields from the pre-signed POST (S3 conditions).
      await new Promise<void>((resolve, reject) => {
        const formData = new FormData();
        Object.entries(fields).forEach(([k, v]) => formData.append(k, v));
        formData.append('file', file); // file must be the LAST field in the form (S3 requirement)

        const xhr = new XMLHttpRequest();
        xhrRef.current = xhr; // store so we can cancel it

        // Progress event fires repeatedly as bytes are sent.
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

      // Step 3: Tell our backend the upload is done so it can verify the file
      // (check metadata, read magic bytes) and mark the session as VERIFIED.
      setState('completing');
      await uploads.complete({ sessionId, uploadKey });
      setState('done');

      // Redirect to the sessions page after a short delay so the user can see the success message.
      setTimeout(() => router.push(`/programs/${programId}/sessions`), 1500);
    } catch (err) {
      setState('error');
      setErrorMsg((err as Error).message || 'Upload failed');
    }
  }

  // Cancels an in-progress upload. XHR.abort() immediately stops the network transfer.
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
