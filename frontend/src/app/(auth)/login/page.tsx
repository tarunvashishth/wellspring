'use client'; // Marks this as a Client Component — runs in the browser, not on the server.
              // Required for useState, event handlers, and browser APIs like localStorage.
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { auth, setToken } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter(); // Next.js hook for programmatic navigation (e.g. redirect after login)

  // useState holds form field values. Each onChange updates only the changed field
  // using the spread operator: { ...f, email: newValue } creates a new object with email replaced.
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');   // shown in red below the form if login fails
  const [loading, setLoading] = useState(false); // disables the button while the request is in flight

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault(); // prevents the browser's default form submission (which would reload the page)
    setError('');
    setLoading(true);
    try {
      // Call the backend POST /auth/login. On success, save the JWT to localStorage.
      // setToken writes to localStorage so the api.ts request helper can include it on future requests.
      const { token } = await auth.login(form);
      setToken(token);
      router.push('/programs'); // redirect to the dashboard
    } catch (err) {
      setError((err as Error).message || 'Login failed'); // display backend error message (e.g. "Invalid email or password")
    } finally {
      setLoading(false); // always re-enable button, even if login failed
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="bg-white rounded-xl shadow p-8 w-full max-w-sm">
        <h1 className="text-2xl font-semibold mb-6 text-gray-900">Sign in to Wellspring</h1>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Email</label>
            <input
              type="email"
              required
              value={form.email}
              onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input
              type="password"
              required
              value={form.password}
              onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-teal-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-teal-700 disabled:opacity-50"
          >
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="mt-4 text-sm text-gray-500 text-center">
          No account?{' '}
          <Link href="/signup" className="text-teal-600 font-medium hover:underline">
            Sign up
          </Link>
        </p>
      </div>
    </div>
  );
}
