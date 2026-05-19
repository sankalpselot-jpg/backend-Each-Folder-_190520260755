/**
 * tests/auth.test.js
 *
 * Integration tests for authentication endpoints.
 * Uses supertest to make real HTTP requests against the Express app.
 *
 * Run: npm test
 * Run with coverage: npm run test:coverage
 */

const request = require('supertest');
const app = require('../server');
const { query, pool } = require('../config/database');

// ─── Test Setup ───────────────────────────────────────────────────────────────
beforeEach(async () => {
  await query("DELETE FROM users WHERE email LIKE '%@test.boothmarket.com'");
});

afterAll(async () => {
  await pool.end();
});

// ─── Registration Tests ───────────────────────────────────────────────────────
describe('POST /api/auth/register', () => {
  const validConsultant = {
    email: 'consultant@test.boothmarket.com',
    password: 'SecurePass123!',
    firstName: 'Test',
    lastName: 'Consultant',
    role: 'consultant',
    phone: '9876543210',
    companyName: 'Test Exhibits Pvt Ltd',
    city: 'Mumbai',
    state: 'Maharashtra',
  };

  it('should register a consultant successfully', async () => {
    const res = await request(app).post('/api/auth/register').send(validConsultant);
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.message.toLowerCase()).toContain('registration');
  });

  it('should register a rental provider successfully', async () => {
    const res = await request(app).post('/api/auth/register').send({
      ...validConsultant,
      email: 'provider@test.boothmarket.com',
      role: 'rental_provider',
      warehouseAddress: '123 Warehouse St, Mumbai',
      deliveryRadiusKm: 100,
    });
    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it('should register a company successfully', async () => {
    const res = await request(app).post('/api/auth/register').send({
      ...validConsultant,
      email: 'company@test.boothmarket.com',
      role: 'company',
      industry: 'Automotive',
    });
    expect(res.status).toBe(201);
  });

  it('should reject duplicate email with 409', async () => {
    await request(app).post('/api/auth/register').send(validConsultant);
    const res = await request(app).post('/api/auth/register').send(validConsultant);
    expect(res.status).toBe(409);
    expect(res.body.message).toContain('already exists');
  });

  it('should reject admin role registration', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...validConsultant, role: 'admin' });
    expect(res.status).toBe(400);
  });

  it('should reject password shorter than 8 characters', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...validConsultant, password: 'abc' });
    expect(res.status).toBe(400);
    expect(res.body.errors[0].field).toBe('password');
  });

  it('should reject invalid email format', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...validConsultant, email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  it('should reject missing firstName', async () => {
    const { firstName, ...noName } = validConsultant;
    const res = await request(app).post('/api/auth/register').send(noName);
    expect(res.status).toBe(400);
  });
});

// ─── Login Tests ──────────────────────────────────────────────────────────────
describe('POST /api/auth/login', () => {
  const testUser = {
    email: 'logintest@test.boothmarket.com',
    password: 'SecurePass123!',
    firstName: 'Login',
    lastName: 'Test',
    role: 'consultant',
  };

  beforeEach(async () => {
    await request(app).post('/api/auth/register').send(testUser);
    // Manually approve for login tests
    await query(
      "UPDATE users SET approval_status = 'approved' WHERE email = $1",
      [testUser.email]
    );
  });

  it('should return access + refresh tokens on valid login', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: testUser.email, password: testUser.password });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.accessToken).toBeDefined();
    expect(res.body.data.refreshToken).toBeDefined();
    expect(res.body.data.user.role).toBe('consultant');
  });

  it('should reject wrong password with 401', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: testUser.email, password: 'WrongPass999!' });
    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('should not reveal whether email exists (generic 401 message)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@test.boothmarket.com', password: 'anypass' });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe('Invalid email or password.');
  });

  it('should block pending users from logging in with 403', async () => {
    await query(
      "UPDATE users SET approval_status = 'pending' WHERE email = $1",
      [testUser.email]
    );
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: testUser.email, password: testUser.password });
    // pending users should not get tokens; they see account-status message
    expect([401, 403]).toContain(res.status);
  });

  it('should block rejected users with 403', async () => {
    await query(
      "UPDATE users SET approval_status = 'rejected' WHERE email = $1",
      [testUser.email]
    );
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: testUser.email, password: testUser.password });
    expect(res.status).toBe(403);
    expect(res.body.approvalStatus).toBe('rejected');
  });
});

// ─── Token Refresh Tests ──────────────────────────────────────────────────────
describe('POST /api/auth/refresh', () => {
  it('should issue new access token with valid refresh token', async () => {
    // Register + approve + login
    const email = 'refresh@test.boothmarket.com';
    await request(app).post('/api/auth/register').send({
      email, password: 'SecurePass123!',
      firstName: 'Refresh', lastName: 'Test', role: 'consultant',
    });
    await query("UPDATE users SET approval_status = 'approved' WHERE email = $1", [email]);
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email, password: 'SecurePass123!' });

    const { refreshToken } = login.body.data;

    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeDefined();
  });

  it('should reject missing refresh token with 401', async () => {
    const res = await request(app).post('/api/auth/refresh').send({});
    expect(res.status).toBe(401);
  });

  it('should reject tampered refresh token', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .send({ refreshToken: 'tampered.token.value' });
    expect(res.status).toBe(401);
  });
});

// ─── Health Check ─────────────────────────────────────────────────────────────
describe('GET /api/health', () => {
  it('should return 200 OK with service info', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('boothmarket-api');
  });
});

// ─── Protected Route Tests ────────────────────────────────────────────────────
describe('Protected routes', () => {
  it('should reject request without Authorization header', async () => {
    const res = await request(app).get('/api/products/my-listings');
    expect(res.status).toBe(401);
  });

  it('should reject request with malformed token', async () => {
    const res = await request(app)
      .get('/api/products/my-listings')
      .set('Authorization', 'Bearer not.a.valid.token');
    expect(res.status).toBe(401);
  });
});
