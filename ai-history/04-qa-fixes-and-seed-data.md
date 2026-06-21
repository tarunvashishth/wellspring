# Session 4 — QA Fixes, Bug Hunting & Seed Data

**Date:** 2026-06-21  
**Branch:** `main`  
**Model:** Claude Sonnet 4.6

---

## Summary

Continued from Session 3. This session focused on running systematic QA on the live application, finding and fixing six bugs, and seeding rich content (programs + sessions) for demo use. All fixes were committed atomically and pushed to GitHub.

---

## Bugs Found & Fixed

### ISSUE-001 — Seed fails: `ON CONFLICT does not support deferrable unique constraints`

**Symptom:** `prisma db seed` crashed on re-runs with a PostgreSQL error.  
**Root cause:** `session.createMany({ skipDuplicates: true })` generates `ON CONFLICT DO NOTHING`, which PostgreSQL rejects for deferrable unique constraints (the `programId_importKey` unique index is backed by a deferrable constraint).  
**Fix:** Replaced `createMany` with a `for` loop of `session.upsert({ where: { programId_importKey: {...} } })`.  
**Commit:** `4796332`

---

### ISSUE-002 — Tenant isolation broken: Alice sees Bob's programs

**Symptom:** RLS policies on `programs`, `sessions`, etc. were not enforced — any logged-in user could see all data.  
**Root cause:** The `wellspring_owner` DB role has `rolbypassrls = true`. All queries ran as this role, so RLS was skipped entirely. `SET LOCAL row_security = on` did not help — table owner bypass persists regardless.  
**Fix:**
1. Granted `app_user` (NOLOGIN, no BYPASSRLS) to `wellspring_owner` as superuser: `GRANT app_user TO wellspring_owner;`
2. In `withTenant()`, added `SET LOCAL ROLE app_user` before setting the tenant GUC, so all tenant queries run as `app_user` and hit RLS.
3. Auth queries (`prisma.creator.findUnique`) run directly as `wellspring_owner` (BYPASSRLS) so login/JWT validation still works without tenant context.
4. Added idempotent `GRANT` to `backend/prisma/migrations/001_init.sql` for fresh installs.

**Files changed:**
- `backend/src/db/prismaWithTenant.ts`
- `backend/prisma/migrations/001_init.sql`

**Commits:** `ad45f6d`, `3e68784`

---

### ISSUE-003 — Duplicate programs after multiple seed runs

**Symptom:** Running `prisma db seed` multiple times created 3× the number of programs for each creator.  
**Root cause:** `program.create()` ran unconditionally on every seed invocation.  
**Fix:** Added a `findOrCreateProgram()` helper that calls `findFirst` before creating.  
**Commit:** `60169b1`

---

### ISSUE-004 — Session Edit/Delete/Upload buttons not firing

**Symptom:** Clicking Edit, Delete, or Upload on a session card did nothing.  
**Root cause:** dnd-kit's drag `listeners` were spread onto the outer `SortableSession` `<div>`, which includes an `onPointerDown` handler that intercepts all pointer events before child button click handlers fire.  
**Fix:** Moved `{...listeners}` from the outer div to a dedicated drag handle `<span>⠿</span>` only. Passed listeners as a `dragListeners` prop to `SessionCard`.  
**File:** `frontend/src/components/SessionList.tsx`  
**Commit:** `29d5659`

---

### ISSUE-005 — Hydration mismatch on import page

**Symptom:** Import page showed "1 error" toast on load. React console warned about hydration mismatch.  
**Root cause:** `useState(() => crypto.randomUUID())` runs on the server during SSR, then runs again on the client — producing two different UUIDs. React detected the mismatch and replaced the server-rendered HTML.  
**Fix:** Initialize `clientImportId` to `''` and set it in a `useEffect` (client-only).

```tsx
// Before:
const [clientImportId] = useState(() => crypto.randomUUID());

// After:
const [clientImportId, setClientImportId] = useState('');
useEffect(() => { setClientImportId(crypto.randomUUID()); }, []);
```

**File:** `frontend/src/app/(dashboard)/programs/[id]/import/page.tsx`  
**Commit:** `6a157c8`

---

### ISSUE-006 — Import endpoint 500: `FOR UPDATE` with aggregate functions

**Symptom:** `POST /programs/:id/imports` always returned `500 Internal Server Error`.  
**Root cause:** `resolveStartPosition()` in `imports.service.ts` ran this query:

```sql
SELECT MAX(s.position) AS max_pos
FROM programs p
LEFT JOIN sessions s ON s.program_id = p.id
WHERE p.id = $1::uuid
FOR UPDATE OF p
```

PostgreSQL does not allow `FOR UPDATE` with aggregate functions — it errors with `FOR UPDATE is not allowed with aggregate functions`.

**Fix:** Split into two queries — lock first, then aggregate:

```typescript
await tx.$executeRaw`SELECT id FROM programs WHERE id = ${programId}::uuid FOR UPDATE`;
const rows = await tx.$queryRaw<{ max_pos: number | null }[]>`
  SELECT MAX(position) AS max_pos FROM sessions WHERE program_id = ${programId}::uuid
`;
```

**File:** `backend/src/imports/imports.service.ts`  
**Commit:** `dfba958`

---

## Seed Data Added (via API)

Created 3 new programs with 17 sessions for `alice@example.com`:

### 30-Day Yoga Journey
| Session | Duration |
|---|---|
| Sun Salutation Basics | 20m |
| Standing Poses Deep Dive | 40m |
| Hip Openers | 30m |
| Backbend Flow | 25m |
| Yin Yoga for Flexibility | 60m |
| Yoga Nidra | 45m |

### HIIT Bootcamp
| Session | Duration |
|---|---|
| Warm-Up & Mobility | 10m |
| Tabata Legs | 20m |
| Upper Body Blast | 20m |
| Core Inferno | 15m |
| Full-Body Circuit | 30m |
| Active Recovery | 25m |

### Sleep & Restore
| Session | Duration |
|---|---|
| Evening Wind-Down | 20m |
| 4-7-8 Breathwork | 15m |
| Legs Up the Wall | 20m |
| Body Scan Meditation | 30m |
| Sleep Hygiene Habits | 10m |

---

## Test Accounts

| Email | Password |
|---|---|
| alice@example.com | Password123! |
| bob@example.com | Password123! |

---

## GitHub

Pushed to [https://github.com/tarunvashishth/wellspring](https://github.com/tarunvashishth/wellspring) (force push — replaced previous divergent history with current implementation).

---

## Key Technical Learnings

- **PostgreSQL BYPASSRLS**: `SET LOCAL row_security = on` does NOT override BYPASSRLS for the role that owns the table. The only fix is `SET LOCAL ROLE <non-bypass-role>`. The owner role must be granted the target role first (`GRANT app_user TO wellspring_owner`).
- **dnd-kit click interception**: Spreading `{...listeners}` on a container div makes every pointer event within that container trigger drag activation. Always scope drag listeners to a handle element.
- **Prisma `createMany` + deferrable constraints**: `skipDuplicates: true` generates `ON CONFLICT DO NOTHING` which PostgreSQL rejects for deferrable unique constraints. Use `upsert` loops instead.
- **Next.js SSR + `crypto.randomUUID()`**: Any randomness in `useState` initializer will differ between server and client renders. Use `useEffect` to set random values client-side only.
- **PostgreSQL `FOR UPDATE` + aggregates**: Cannot combine `FOR UPDATE` with `MAX()` or any aggregate function in the same query. Must separate into a lock query followed by an aggregate query.
