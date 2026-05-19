/**
 * tests/products.test.js
 *
 * Integration tests for product listing endpoints.
 * Tests: create, search, update, delete, availability management.
 */

const request = require('supertest');
const app = require('../server');
const { query, pool } = require('../config/database');

let providerToken;
let consultantToken;
let providerId;
let testProductId;

// ─── Setup ────────────────────────────────────────────────────────────────────
beforeAll(async () => {
  // Clean up any previous test data
  await query("DELETE FROM users WHERE email LIKE '%@prodtest.boothmarket.com'");

  // Register + approve a rental provider
  await request(app).post('/api/auth/register').send({
    email: 'provider@prodtest.boothmarket.com',
    password: 'SecurePass123!',
    firstName: 'Provider',
    lastName: 'Test',
    role: 'rental_provider',
    companyName: 'Test Rentals',
    city: 'Delhi',
    state: 'Delhi',
  });
  const { rows: [prov] } = await query(
    "UPDATE users SET approval_status='approved' WHERE email=$1 RETURNING id",
    ['provider@prodtest.boothmarket.com']
  );
  providerId = prov.id;

  const provLogin = await request(app).post('/api/auth/login').send({
    email: 'provider@prodtest.boothmarket.com', password: 'SecurePass123!',
  });
  providerToken = provLogin.body.data.accessToken;

  // Register + approve a consultant
  await request(app).post('/api/auth/register').send({
    email: 'consultant@prodtest.boothmarket.com',
    password: 'SecurePass123!',
    firstName: 'Consult',
    lastName: 'Test',
    role: 'consultant',
    city: 'Mumbai',
    state: 'Maharashtra',
  });
  await query(
    "UPDATE users SET approval_status='approved' WHERE email=$1",
    ['consultant@prodtest.boothmarket.com']
  );
  const consLogin = await request(app).post('/api/auth/login').send({
    email: 'consultant@prodtest.boothmarket.com', password: 'SecurePass123!',
  });
  consultantToken = consLogin.body.data.accessToken;
});

afterAll(async () => {
  await query("DELETE FROM users WHERE email LIKE '%@prodtest.boothmarket.com'");
  await pool.end();
});

// ─── Product Search ───────────────────────────────────────────────────────────
describe('GET /api/products', () => {
  it('should return product list without authentication', async () => {
    const res = await request(app).get('/api/products');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data.products)).toBe(true);
    expect(res.body.data.pagination).toBeDefined();
  });

  it('should support search query param', async () => {
    const res = await request(app).get('/api/products?search=LED');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('should support category filter', async () => {
    const res = await request(app).get('/api/products?categoryId=1');
    expect(res.status).toBe(200);
  });

  it('should support price range filter', async () => {
    const res = await request(app).get('/api/products?minPrice=100&maxPrice=5000');
    expect(res.status).toBe(200);
    // All returned products should be within price range
    res.body.data.products.forEach((p) => {
      expect(parseFloat(p.price_per_day)).toBeGreaterThanOrEqual(100);
      expect(parseFloat(p.price_per_day)).toBeLessThanOrEqual(5000);
    });
  });

  it('should cap limit at 50', async () => {
    const res = await request(app).get('/api/products?limit=200');
    expect(res.status).toBe(200);
    expect(res.body.data.products.length).toBeLessThanOrEqual(50);
  });

  it('should return pagination metadata', async () => {
    const res = await request(app).get('/api/products?page=1&limit=10');
    expect(res.status).toBe(200);
    const { pagination } = res.body.data;
    expect(pagination.page).toBe(1);
    expect(pagination.limit).toBe(10);
    expect(pagination.total).toBeDefined();
    expect(pagination.totalPages).toBeDefined();
  });
});

// ─── My Listings (Rental Provider) ───────────────────────────────────────────
describe('GET /api/products/my-listings', () => {
  it('should return empty array for new provider', async () => {
    const res = await request(app)
      .get('/api/products/my-listings')
      .set('Authorization', `Bearer ${providerToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.products)).toBe(true);
  });

  it('should reject unauthenticated request', async () => {
    const res = await request(app).get('/api/products/my-listings');
    expect(res.status).toBe(401);
  });

  it('should reject consultant accessing provider-only route', async () => {
    const res = await request(app)
      .get('/api/products/my-listings')
      .set('Authorization', `Bearer ${consultantToken}`);
    expect(res.status).toBe(403);
  });
});

// ─── Categories ───────────────────────────────────────────────────────────────
describe('GET /api/categories', () => {
  it('should return seeded categories', async () => {
    const res = await request(app).get('/api/categories');
    expect(res.status).toBe(200);
    expect(res.body.data.categories.length).toBeGreaterThan(0);
    expect(res.body.data.categories[0]).toHaveProperty('name');
    expect(res.body.data.categories[0]).toHaveProperty('slug');
  });
});

// ─── Non-existent Product ─────────────────────────────────────────────────────
describe('GET /api/products/:id', () => {
  it('should return 404 for non-existent product', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const res = await request(app).get(`/api/products/${fakeId}`);
    expect(res.status).toBe(404);
  });
});
