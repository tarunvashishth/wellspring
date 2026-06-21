import supertest from 'supertest';
import { Pool } from 'pg';
import app from '../src/app';

// Direct DB connection as superuser — bypasses RLS for test fixtures
const testDb = new Pool({ connectionString: process.env.DATABASE_URL_ADMIN });

interface Creator {
  id: string;
  token: string;
  programId: string;
  sessionId: string;
}

async function createTestCreator(
  email: string,
  displayName: string,
): Promise<Creator> {
  const signupRes = await supertest(app)
    .post('/auth/signup')
    .send({ email, password: 'Password123!', displayName });
  expect(signupRes.status).toBe(201);

  const { id } = signupRes.body.creator;
  const { token } = signupRes.body;

  // Insert program directly as superuser to avoid rate limits / quota
  const { rows: [prog] } = await testDb.query(
    `INSERT INTO programs (creator_id, title, tags) VALUES ($1, $2, '{}') RETURNING id`,
    [id, `${displayName}'s Program`],
  );

  const { rows: [sess] } = await testDb.query(
    `INSERT INTO sessions (program_id, creator_id, title, duration_seconds, position)
     VALUES ($1, $2, 'Test Session', 600, 1) RETURNING id`,
    [prog.id, id],
  );

  return { id, token, programId: prog.id, sessionId: sess.id };
}

beforeAll(async () => {
  // Clean slate for test creators
  await testDb.query(`DELETE FROM creators WHERE email LIKE '%@test.wellspring'`);
});

afterAll(async () => {
  await testDb.query(`DELETE FROM creators WHERE email LIKE '%@test.wellspring'`);
  await testDb.end();
});

describe('Cross-tenant program access', () => {
  let alice: Creator;
  let bob: Creator;

  beforeAll(async () => {
    alice = await createTestCreator('alice@test.wellspring', 'Alice');
    bob = await createTestCreator('bob@test.wellspring', 'Bob');
  });

  test("GET /programs/:id rejects Bob's access to Alice's program", async () => {
    const res = await supertest(app)
      .get(`/programs/${alice.programId}`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(res.status).toBe(404);
  });

  test("PATCH /programs/:id rejects Bob's update of Alice's program", async () => {
    const res = await supertest(app)
      .patch(`/programs/${alice.programId}`)
      .set('Authorization', `Bearer ${bob.token}`)
      .send({ title: 'Hijacked' });
    expect(res.status).toBe(404);
  });

  test("DELETE /programs/:id rejects Bob's deletion of Alice's program", async () => {
    const res = await supertest(app)
      .delete(`/programs/${alice.programId}`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(res.status).toBe(404);
  });

  test("GET /programs/:id/sessions rejects Bob's access to Alice's sessions", async () => {
    const res = await supertest(app)
      .get(`/programs/${alice.programId}/sessions`)
      .set('Authorization', `Bearer ${bob.token}`);
    // Returns empty array (RLS filters, not 404) because program read is not checked here
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('Alice can still access her own program', async () => {
    const res = await supertest(app)
      .get(`/programs/${alice.programId}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(alice.programId);
  });

  test('Bob can still access his own program', async () => {
    const res = await supertest(app)
      .get(`/programs/${bob.programId}`)
      .set('Authorization', `Bearer ${bob.token}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(bob.programId);
  });
});

describe('Cross-tenant session operations', () => {
  let carol: Creator;
  let dave: Creator;

  beforeAll(async () => {
    carol = await createTestCreator('carol@test.wellspring', 'Carol');
    dave = await createTestCreator('dave@test.wellspring', 'Dave');
  });

  test("PATCH /sessions/:id rejects Dave's update of Carol's session", async () => {
    const res = await supertest(app)
      .patch(`/programs/${carol.programId}/sessions/${carol.sessionId}`)
      .set('Authorization', `Bearer ${dave.token}`)
      .send({ title: 'Hijacked Session' });
    expect(res.status).toBe(404);
  });

  test("DELETE /sessions/:id rejects Dave's deletion of Carol's session", async () => {
    const res = await supertest(app)
      .delete(`/programs/${carol.programId}/sessions/${carol.sessionId}`)
      .set('Authorization', `Bearer ${dave.token}`);
    expect(res.status).toBe(404);
  });

  test("PUT /sessions/reorder rejects Dave's reorder of Carol's sessions", async () => {
    const res = await supertest(app)
      .put(`/programs/${carol.programId}/sessions/reorder`)
      .set('Authorization', `Bearer ${dave.token}`)
      .send({ orderedIds: [carol.sessionId] });
    expect(res.status).toBe(404);
  });

  test("Carol's session update succeeds", async () => {
    const res = await supertest(app)
      .patch(`/programs/${carol.programId}/sessions/${carol.sessionId}`)
      .set('Authorization', `Bearer ${carol.token}`)
      .send({ title: 'Updated by Carol' });
    expect(res.status).toBe(200);
    expect(res.body.title).toBe('Updated by Carol');
  });

  test("Dave cannot create a session under Carol's program", async () => {
    const res = await supertest(app)
      .post(`/programs/${carol.programId}/sessions`)
      .set('Authorization', `Bearer ${dave.token}`)
      .send({ title: 'Injected Session', durationSeconds: 300 });
    // RLS on programs prevents resolving programId for Dave — will 404
    expect(res.status).toBe(404);
  });
});

describe('Cross-tenant audit log access', () => {
  let eve: Creator;
  let frank: Creator;

  beforeAll(async () => {
    eve = await createTestCreator('eve@test.wellspring', 'Eve');
    frank = await createTestCreator('frank@test.wellspring', 'Frank');
    // Generate an audit log for Eve by updating her program
    await supertest(app)
      .patch(`/programs/${eve.programId}`)
      .set('Authorization', `Bearer ${eve.token}`)
      .send({ title: "Eve's Updated Program" });
  });

  test("Frank cannot see Eve's audit logs", async () => {
    const res = await supertest(app)
      .get('/audit')
      .set('Authorization', `Bearer ${frank.token}`);
    expect(res.status).toBe(200);
    // Frank's log has 0 program.update events (Eve's event is invisible)
    const updateEvents = res.body.items.filter((l: { action: string }) => l.action === 'program.update');
    expect(updateEvents).toHaveLength(0);
  });

  test("Eve can see her own audit logs", async () => {
    const res = await supertest(app)
      .get('/audit')
      .set('Authorization', `Bearer ${eve.token}`);
    expect(res.status).toBe(200);
    const updateEvents = res.body.items.filter((l: { action: string }) => l.action === 'program.update');
    expect(updateEvents.length).toBeGreaterThanOrEqual(1);
  });

  test('Audit log response never contains another tenant id', async () => {
    const res = await supertest(app)
      .get('/audit')
      .set('Authorization', `Bearer ${frank.token}`);
    expect(res.status).toBe(200);
    for (const log of res.body.items) {
      expect(log.creatorId).toBe(frank.id);
    }
  });
});
