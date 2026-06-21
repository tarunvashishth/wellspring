# Code Summary

## Auth

### Purpose
Handles creator identity: signup, login, logout, and password reset. Issues JWTs and enforces logout across restarts and multiple instances.

### Design Decisions

**Single ORM (Prisma).** Auth models (`Creator`, `PasswordResetToken`) live in the Prisma schema alongside the rest of the domain. No Knex, no second connection pool competing for `max_connections`.

**Redis-backed JWT denylist.** On logout, the token's `jti` is written to Redis with `SETEX jti <remaining_ttl> 1`. Every `verifyToken` call checks `EXISTS jti` before accepting the token. The key self-prunes at expiry — no cron job needed. This makes logout correct across restarts, redeploys, and horizontal scale. An in-memory `Map` cannot do any of these things.

**Timing-safe login.** The bcrypt comparison always runs — even when the email doesn't exist — using a pre-computed `DUMMY_HASH`. This closes the timing oracle that would allow email enumeration via response latency.

**JWT algorithm whitelist.** `jwt.verify` is called with `{ algorithms: ['HS256'] }`. Without this, a token signed with `alg: none` would be accepted by default in older `jsonwebtoken` versions.

**Previous-secret rotation.** `JWT_SECRET_PREVIOUS` allows a secret rotation without invalidating all live sessions. `verifyToken` tries the current secret first, falls back to the previous one on failure.

**Password reset via SHA-256 token hash.** The raw token is sent to the user (over email, not stored). Only the SHA-256 hash is stored. `SELECT FOR UPDATE` on the token row prevents double-use under concurrent requests.

**Out-of-transaction audit for auth events.** Login and signup write audit rows via `writeSecurityAudit`, which swallows errors. These events happen outside a tenant transaction (the GUC isn't set yet at login time), so best-effort is the correct strategy — a failed audit write must never block authentication.

**Rate limiting on login.** `express-rate-limit` keyed by `req.body.email` (not IP) so a single attacker can't bypass by rotating IPs while targeting one account.

### Extension Points

- **OAuth / SSO.** Add a `CreatorIdentity` table (`{ creatorId, provider, providerUserId }`) and an `/auth/oauth/:provider/callback` route. The core `Creator` record and JWT issuance stay unchanged.
- **Refresh tokens.** Add a `RefreshToken` table with a `family` column for rotation. Issue short-lived access tokens (15m) and longer-lived refresh tokens (30d). The Redis denylist still handles access token revocation.
- **MFA.** Add a `mfaSecret` column to `Creator`, a `POST /auth/mfa/setup` route for TOTP enrollment, and a second factor check in the login flow before issuing the JWT.
- **Multi-tenancy for teams.** Replace the 1:1 `Creator`→tenant model with an `Organization` entity. Add a `Membership` join table and change `current_tenant_id()` to resolve the org from the JWT claim.

---

## Programs

### Purpose
CRUD for the top-level content container. A program is a named, tagged collection of sessions owned by a single creator.

### Design Decisions

**`updateMany`/`deleteMany` with `creatorId` in the WHERE clause.** Every mutation filters by both `id` and `creatorId`. If the row doesn't belong to the authenticated creator — whether because it doesn't exist or because it belongs to another tenant — `result.count === 0` and the handler returns 404. This is TOCTOU-safe: there is no separate ownership check followed by a mutation; the ownership check *is* the mutation predicate.

**RLS as the second layer.** Even if the `creatorId` filter were somehow removed from the service, RLS on the `programs` table would prevent the mutation from seeing the row. Defense in depth: the service-layer check and the database-layer policy cover each other.

**Per-creator program cap enforced inside the transaction.** `COUNT` + `CREATE` run inside the same `withTenant` transaction. The count is not a pre-check that races with concurrent creates.

**`SAFE_TEXT_RE` on title and tags.** Rejects Unicode control characters and bidirectional override sequences (e.g., U+202E). These can make malicious content look benign in audit logs or UI renders without the regex check.

**Tag validation per-element with path.** The Zod schema validates each tag individually so error messages identify the offending element (`tags[2]: Tag contains invalid characters`) rather than rejecting the whole array.

### Extension Points

- **Search and filtering.** Add `GET /programs?q=yoga&tag=morning` with a Postgres full-text index on `title` and a GIN index on `tags`.
- **Sharing / publishing.** Add a `visibility` enum (`PRIVATE`, `UNLISTED`, `PUBLIC`) and a separate read path that bypasses RLS for public programs.
- **Program templates.** Allow cloning a program (including its sessions) via `POST /programs/:id/clone`. The import key on sessions would be cleared so positions recompute cleanly.
- **Ordering.** Add a `position` column and a reorder endpoint mirroring the sessions module. The DEFERRABLE INITIALLY DEFERRED pattern from sessions applies directly.

---

## Sessions

### Purpose
Ordered content items within a program. Each session has a title, duration, position, and optional media attachment. Sessions support drag-to-reorder with conflict-safe position semantics.

### Design Decisions

**DEFERRABLE INITIALLY DEFERRED on `(program_id, position)`.** The position uniqueness constraint is deferred to commit time. This allows a reorder operation to write intermediate states where positions temporarily overlap within the same transaction, then resolve to a unique set at commit. Without `DEFERRABLE`, a naive in-order UPDATE would hit a unique violation on the first row.

**Composite FK `(program_id, creator_id) → programs(id, creator_id)`.** A session cannot reference a program it doesn't share a `creator_id` with. This makes cross-tenant session injection impossible at the database level, independent of any application-layer check.

**`SELECT FOR UPDATE` on the program row before reorder.** Acquiring a row lock on the program serializes concurrent reorder and import operations that target the same program. Without this lock, a concurrent import (which computes `MAX(position)` to place new sessions) and a concurrent reorder (which reassigns all positions) could interleave and produce duplicate positions that only surface as a P2034 at commit.

**`updateMany`/`deleteMany` with both `id` and `creatorId`.** Same pattern as programs — ownership check and mutation are atomic.

**Position assigned as `MAX(position) + 1` inside the transaction.** New sessions are always appended. The position is not passed by the client, eliminating a whole class of client-supplied ordering attacks.

### Extension Points

- **Session prerequisites.** Add a `SessionDependency` join table (`{ sessionId, prerequisiteId }`) and expose it in the session detail response. The frontend can render a DAG or lock sessions until prerequisites are complete.
- **Draft / published state.** Add a `status` enum. Published sessions are visible to students; drafts are only visible to the creator. A separate read path bypasses the status filter for the owning creator.
- **Bulk position recompute.** After many deletes, positions can become sparse. Add a `POST /programs/:id/sessions/reindex` endpoint that reassigns `1..N` in a single transaction using `ROW_NUMBER()` in a CTE.
- **Subtitles / transcripts.** Add a `Transcript` table with a FK to `Session`. The upload flow can accept `.vtt` or `.srt` files through the same presigned POST pipeline.

---

## Uploads

### Purpose
Securely attaches media files to sessions. The file travels directly from the browser to S3 — the backend never proxies the bytes. After upload, the backend fetches the first 16 bytes from S3 and validates magic bytes before setting `mediaStatus = VERIFIED`.

### Design Decisions

**Presigned POST (not presigned PUT).** `createPresignedPost` supports policy conditions that a presigned PUT cannot enforce: `content-length-range`, exact `Content-Type` match, server-side encryption, and metadata. These conditions are enforced by S3 itself — a client that violates them gets a 403 directly from S3, before the backend is involved.

**Five independent security layers.**
1. POST policy `content-length-range` — S3 rejects oversized files.
2. Exact `Content-Type` condition — S3 rejects type mismatches.
3. `x-amz-server-side-encryption: AES256` required — all stored objects are encrypted at rest.
4. Metadata conditions (`creator-id`, `session-id`) — S3 rejects uploads that omit them.
5. Magic-byte check at `/complete` — the backend fetches bytes 0–15 from the stored object and validates against known audio/video signatures. A file with a valid extension and MIME type but wrong content (e.g., a PHP shell renamed to `.mp4`) is rejected here.

**Upload key built server-side only.** `buildUploadKey` runs in the backend, not the client. The key embeds `creatorId` and `sessionId` in the path prefix (`uploads/<creatorId>/<sessionId>/`). At `/complete`, the backend verifies `uploadKey.startsWith('uploads/${tenantId}/')` before doing anything else.

**`safeDeleteObject` on any verification failure.** If metadata verification or magic-byte check fails, the object is deleted from S3 before returning the error. Rejected files don't accumulate in the bucket.

**`VERIFIED` is the only terminal success state.** `mediaStatus` starts at `PENDING`, moves to `PROCESSING` at `/initiate`, and only reaches `VERIFIED` after magic-byte validation succeeds. `FAILED` is set on validation failure. There is no code path that leaves a session permanently at `PROCESSING`.

### Extension Points

- **Lambda / async verification.** Replace the synchronous range GET at `/complete` with an S3 event → Lambda trigger. The Lambda runs deeper content inspection (ffprobe, virus scan) and writes `mediaStatus` via an internal API. The `/complete` endpoint becomes a fire-and-forget that sets `PROCESSING`; the client polls `GET /sessions/:id` for status.
- **Adaptive streaming.** After verification, trigger a transcoding job (MediaConvert, Mux) to produce HLS/DASH output. Add a `streamUrl` column to `Media` for the playback URL.
- **Chunked / multipart upload.** For files over the POST policy limit, switch to `createMultipartUpload` → N presigned part URLs → `completeMultipartUpload`. The backend coordinates the part URLs and finalizes the upload; magic-byte check still runs at completion.
- **Image support.** Add `image/jpeg`, `image/png`, `image/webp` to the allowed content types and extend `validateMagicBytes` with their signatures. Useful for program thumbnails.

---

## Imports

### Purpose
Bulk-creates sessions from a CSV file. Designed for idempotency at both the request level and the row level — re-submitting the same file or the same row produces no duplicates.

### Design Decisions

**Two-layer idempotency.**
- *Request level:* `clientImportId` (a UUID supplied by the client) has a `UNIQUE` constraint on `bulk_imports`. A duplicate request hits P2002, which is caught and converted to a 202 response identifying the winning import's ID.
- *Row level:* `importKey` is a SHA-256 hash of the session title, stored in a partial unique index `(program_id, import_key) WHERE import_key IS NOT NULL`. Re-importing the same title is a no-op.

**Race condition on concurrent imports of the same `clientImportId`.** Two requests racing to create the `BulkImport` record will have one win (create succeeds) and one lose (P2002). The loser catches the error as `ConcurrentImportError`, queries for the winner's ID, and returns it in a 202 response. The client sees a consistent `importId` regardless of which request it was.

**`SELECT FOR UPDATE` on the program row.** `resolveStartPosition` acquires a row lock on the program before computing `MAX(position)`. This serializes all concurrent imports and reorder operations on the same program, preventing position gaps or duplicates when multiple imports run simultaneously.

**Validation errors written in a separate post-commit transaction.** Row-level validation errors (schema failures) are written to `import_errors` in a second `withTenant` call after the main transaction commits. This is best-effort — a failure to write error rows doesn't roll back the successful session inserts. The main import result is never contaminated by the error-writing path.

**`creator_id` denormalized onto `import_errors`.** The RLS policy on `import_errors` is `USING (creator_id = current_tenant_id())` — a direct column comparison. The alternative (a correlated subquery through `bulk_imports`) would execute once per row at read time, which degrades to a full table scan with millions of error rows.

**Stuck import recovery.** If a prior import is found in `PENDING` or `PROCESSING` state past a configurable threshold (`IMPORT_STUCK_PENDING_MS`, `IMPORT_STUCK_PROCESSING_MS`), the system allows a re-run. This handles crashed workers without requiring manual intervention.

**CSV validation via Zod per-row.** Each row is validated independently. Valid rows proceed; invalid rows collect errors with their row number and field name. The import completes as `PARTIAL` if any rows fail, `COMPLETED` if all pass. The client can distinguish these states and display per-row feedback.

### Extension Points

- **Outbox / background worker.** Move the long transaction into a background job queue (BullMQ, pg-boss). The API returns 202 immediately with the `importId`; the worker processes the CSV and updates status. The client polls `GET /imports/:id` or receives a webhook. This eliminates the connection-pool exhaustion risk under concurrent large imports.
- **Streaming CSV parse.** Replace `csv-parse/sync` with the streaming API and process rows in batches of 500. Each batch is a separate transaction, reducing lock hold time and enabling progress reporting.
- **Column mapping.** Accept a `columnMap` JSON body parameter that maps client column names to the schema fields (`{ "Session Title": "title", "Duration (s)": "duration_seconds" }`). Allows import of files not matching the exact schema.
- **Import templates.** Add `GET /imports/template` returning a CSV with headers and example rows. Reduces client-side guesswork about the required format.

---

## Audit

### Purpose
Immutable, per-tenant record of all significant actions: CRUD on programs and sessions, imports, uploads, and auth events. Supports filtering and cursor-based pagination for the audit log UI.

### Design Decisions

**Atomic with the mutation.** `writeAudit` accepts the same `Prisma.TransactionClient` as the caller's mutation. Both the data change and the audit row commit or roll back together. There are no orphaned audit rows from failed mutations, and no mutation can silently skip audit logging.

**Separate path for auth events.** Login and signup happen before a tenant context is established (the GUC isn't set). `writeSecurityAudit` writes outside a tenant transaction and swallows errors. A failed audit write must never block authentication.

**BigInt autoincrement as cursor.** `AuditLog.id` is a `BigInt` autoincrement. Because IDs are assigned in insertion order, `WHERE id < :cursor ORDER BY id DESC` is an efficient keyset pagination pattern using the primary key index. No secondary index on `createdAt` is needed for the common case.

**90-day maximum query range.** `listAuditLogs` rejects date ranges over 90 days. This is a query cost bound — unbounded range scans on a high-write table can dominate I/O under production load.

**`severity` as a string column, not an enum.** `info`, `warn`, `critical` covers current needs. A string column allows adding new severity levels without a migration. The Zod enum on the query parameter validates client input; the DB column is unconstrained.

**`requestId` and `ipAddress` propagated via AsyncLocalStorage.** `getPartialContext()` is called inside `writeAudit` — the caller doesn't need to thread these values through. ALS stores them at the middleware layer and makes them available anywhere in the call stack without parameter drilling.

### Extension Points

- **Alerting on critical events.** Add a post-write hook in `writeAudit` that publishes to a Redis pub/sub channel or SNS topic when `severity === 'critical'`. An alerting worker subscribes and sends Slack/PagerDuty notifications.
- **Export.** Add `GET /audit/export?format=csv` that streams a cursor-paginated result directly to the response as CSV. Useful for compliance exports.
- **Retention policy.** Add a background job that deletes audit rows older than a configurable retention period (e.g., 1 year) using `DELETE WHERE created_at < NOW() - INTERVAL '1 year'` in batches to avoid long-running locks.
- **Event replay.** Store a `before` and `after` snapshot in `metadata` for update operations. This enables point-in-time reconstruction of entity state from the audit log — a foundation for an undo feature or a full event-sourcing migration.
