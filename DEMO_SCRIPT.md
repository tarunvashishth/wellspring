# Wellspring — Demo Script

---

## 1 · Quick App Demo *(1 min)*

> Open browser at `http://localhost:4000`

**"Let me show you Wellspring — a multi-tenant content platform for wellness creators."**

1. **Log in as Alice** — `alice@example.com / Password123!`
   - "Each creator has a completely isolated workspace."

2. **Programs list** — point to the cards
   - "Alice has programs like *30-Day Yoga Journey* and *HIIT Bootcamp*. Each program holds ordered sessions."

3. **Open a program → Sessions view**
   - Drag a session to reorder it. "Reordering is live — it hits the DB immediately with a deferred unique constraint so positions never collide mid-transaction."
   - Click **Edit** on a session → change the title → Save. "Full CRUD on sessions."

4. **Open another tab → log in as Bob** — `bob@example.com / Password123!`
   - "Bob sees only his own programs. He cannot see Alice's data — not even with a direct URL."
   - Try navigating to one of Alice's program IDs: `http://localhost:4000/programs/<alice-program-id>/sessions`
   - "404. RLS at the database level — not just application checks."

5. **Import CSV** — go to any program → Import
   - "Bulk import with row-level validation. Valid rows land, invalid rows surface per-row error detail."

---

## 2 · Schema & Tenant Isolation in Code *(2 min)*

### The schema

> Open `backend/prisma/schema.prisma`

```
Creator → Program → Session
              ↓
          BulkImport → ImportError
              ↓
            Media
```

- **Every table has `creator_id`** — the tenant key.
- **`Session` has a composite FK** `(program_id, creator_id) → programs(id, creator_id)` enforced at the DB level. A session can never be assigned to another creator's program, even by a bug.

---

### The isolation problem most implementations get wrong

> Open `backend/src/db/prismaWithTenant.ts`

```ts
await tx.$executeRawUnsafe(`SET LOCAL ROLE app_user`);
await tx.$executeRawUnsafe(`SELECT set_config('app.current_tenant', '${tenantId}', true)`);
```

**"The naive approach is to add `WHERE creator_id = $tenantId` everywhere in application code. That breaks the moment someone forgets it. We enforce it at the database level with PostgreSQL Row-Level Security."**

> Open `backend/prisma/migrations/001_init.sql`

```sql
CREATE POLICY programs_isolation ON programs
  USING (creator_id = current_tenant_id());
```

**"Every query on `programs`, `sessions`, `media`, `bulk_imports` — all of them — is filtered by this policy automatically. The application can't accidentally leak data."**

**"But there's a catch."** Point to `SET LOCAL ROLE app_user`:

> "Our DB connection runs as `wellspring_owner`, which has `BYPASSRLS = true` — a superuser-like flag. RLS policies are simply ignored for it. During QA I caught this: Alice could see Bob's programs. The fix is to switch roles inside every transaction to `app_user`, a NOLOGIN role with no bypass. `SET LOCAL ROLE` is scoped to the transaction — it automatically reverts when the transaction commits or rolls back. Auth queries that need to run before a tenant is known still run as `wellspring_owner`, which is correct."

---

## 3 · How I Used AI to Build This *(1–2 min)*

**"The assessment explicitly says AI usage is expected and evaluated. Here's exactly how I used it."**

- **Upfront analysis** — I had Claude act as a senior staff engineer and dissect the spec before writing a line of code. It surfaced hidden requirements I would have missed: the deferrable unique constraint for session reordering, the BYPASSRLS trap, the hydration mismatch risk on the import page.

- **Implementation** — Claude wrote the majority of the boilerplate: Prisma schema, Express routers, Next.js pages, seed script. I treated it like a very fast junior engineer — I reviewed every output, caught mistakes, and directed the architecture.

- **QA loop** — I ran a structured QA pass using a browser automation tool. It found 6 real bugs: the RLS bypass, a dnd-kit pointer event intercepting button clicks, a React hydration mismatch, a seed idempotency issue, and two import service bugs. Each was fixed atomically with a named commit.

- **What I kept full control of** — the RLS architecture, the role-switching fix, the composite FK design, and the decision to use `SET LOCAL` scoped transactions rather than a per-request middleware approach.

**"AI compressed a multi-day build into a focused sprint. But it doesn't replace engineering judgment — it amplifies it."**

---

## 4 · One Thing I'd Do Differently *(1 min)*

**"I'd replace MinIO with a proper S3-compatible object store from day one."**

The upload flow is solid — presigned POST policy, `content-length-range`, server-side encryption condition, HeadObject verification at `/complete`. But the local MinIO setup added friction: CORS configuration, path-style vs virtual-hosted URLs, credential bootstrapping.

In production this would be S3 or Cloudflare R2. The code wouldn't change — just the endpoint and credentials. But starting there would have saved the setup overhead and made the upload flow immediately testable in a staging environment.

**"More broadly: I'd add an integration test suite that spins up a real Postgres instance with RLS enabled and tests cross-tenant isolation directly — not mocked. That's the one gap I'd close before calling this production-ready."**

---

*Total: ~5–6 minutes*
