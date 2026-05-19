/**
 * routes/index.js
 * 
 * Central route registry. All API routes are mounted here.
 * 
 * Base URL: /api
 * ├── /auth          → Authentication (public)
 * ├── /products      → Rental product listings
 * ├── /inquiries     → Inquiry management
 * ├── /admin         → Admin-only operations
 * ├── /categories    → Product categories (public)
 * └── /profile       → User profile management
 */

const express = require('express');
const router = express.Router();

// ─── Import Controllers ───────────────────────────────────────────────────────
const authController = require('../controllers/authController');
const productController = require('../controllers/productController');
const inquiryController = require('../controllers/inquiryController');
const adminController = require('../controllers/adminController');

// ─── Import Middleware ────────────────────────────────────────────────────────
const { authenticate, authorize, requireApproved } = require('../middleware/auth');
const { query } = require('../config/database');

// ─── Input Validation ─────────────────────────────────────────────────────────
const { body, validationResult } = require('express-validator');

// Validation middleware factory — runs validators and returns errors if any
const validate = (validations) => async (req, res, next) => {
  await Promise.all(validations.map((v) => v.run(req)));
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: 'Validation failed.',
      errors: errors.array().map((e) => ({ field: e.path, message: e.msg })),
    });
  }
  next();
};

// ─── AUTH ROUTES ──────────────────────────────────────────────────────────────
// POST /api/auth/register
router.post('/auth/register',
  validate([
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
    body('firstName').trim().notEmpty().withMessage('First name required'),
    body('lastName').trim().notEmpty().withMessage('Last name required'),
    body('role').isIn(['consultant', 'rental_provider', 'company']).withMessage('Invalid role'),
  ]),
  authController.register
);

// POST /api/auth/login
router.post('/auth/login',
  validate([
    body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
    body('password').notEmpty().withMessage('Password required'),
  ]),
  authController.login
);

// POST /api/auth/refresh
router.post('/auth/refresh', authController.refreshToken);

// POST /api/auth/logout
router.post('/auth/logout', authController.logout);

// POST /api/auth/forgot-password
router.post('/auth/forgot-password',
  validate([body('email').isEmail().normalizeEmail()]),
  authController.forgotPassword
);

// POST /api/auth/reset-password
router.post('/auth/reset-password',
  validate([
    body('token').notEmpty().withMessage('Reset token required'),
    body('newPassword').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  ]),
  authController.resetPassword
);

// ─── PRODUCT ROUTES ───────────────────────────────────────────────────────────
// GET /api/products — Public search/browse (no auth required)
router.get('/products', productController.getProducts);

// GET /api/products/my-listings — Provider's own listings
router.get('/products/my-listings',
  authenticate, requireApproved, authorize('rental_provider'),
  productController.getMyListings
);

// GET /api/products/:id — Public single product view
router.get('/products/:id', productController.getProductById);

// POST /api/products — Create listing (rental_provider only)
router.post('/products',
  authenticate, requireApproved, authorize('rental_provider'),
  productController.createProduct
);

// PUT /api/products/:id — Update listing
router.put('/products/:id',
  authenticate, requireApproved, authorize('rental_provider'),
  productController.updateProduct
);

// DELETE /api/products/:id — Delete listing
router.delete('/products/:id',
  authenticate, requireApproved, authorize('rental_provider'),
  productController.deleteProduct
);

// POST /api/products/:id/availability — Manage blocked dates
router.post('/products/:id/availability',
  authenticate, requireApproved, authorize('rental_provider'),
  validate([
    body('blockedDates').isArray({ min: 1 }).withMessage('blockedDates array required'),
    body('action').isIn(['block', 'unblock']).withMessage('action must be block or unblock'),
  ]),
  productController.updateAvailability
);

// ─── INQUIRY ROUTES ───────────────────────────────────────────────────────────
// POST /api/inquiries — Consultant sends an inquiry
router.post('/inquiries',
  authenticate, requireApproved, authorize('consultant'),
  validate([
    body('productId').isUUID().withMessage('Valid product ID required'),
    body('rentalStartDate').isDate().withMessage('Valid start date required (YYYY-MM-DD)'),
    body('rentalEndDate').isDate().withMessage('Valid end date required (YYYY-MM-DD)'),
    body('consultantMessage').trim().isLength({ min: 20 }).withMessage('Message must be at least 20 characters'),
    body('quantityNeeded').optional().isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
  ]),
  inquiryController.createInquiry
);

// GET /api/inquiries — Get my inquiries (consultant or provider)
router.get('/inquiries',
  authenticate, requireApproved, authorize('consultant', 'rental_provider'),
  inquiryController.getMyInquiries
);

// POST /api/inquiries/:id/respond — Provider responds
router.post('/inquiries/:id/respond',
  authenticate, requireApproved, authorize('rental_provider'),
  validate([
    body('status').isIn(['accepted', 'declined']).withMessage('Status must be accepted or declined'),
    body('response').trim().notEmpty().withMessage('Response message is required'),
  ]),
  inquiryController.respondToInquiry
);

// POST /api/inquiries/:id/cancel — Consultant cancels
router.post('/inquiries/:id/cancel',
  authenticate, requireApproved, authorize('consultant'),
  inquiryController.cancelInquiry
);

// ─── CATEGORIES ROUTE ─────────────────────────────────────────────────────────
// GET /api/categories — Public list of product categories
router.get('/categories', async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT id, name, slug, icon_url FROM product_categories WHERE is_active = true ORDER BY name'
    );
    res.json({ success: true, data: { categories: rows } });
  } catch (err) {
    next(err);
  }
});

// ─── PROFILE ROUTES ───────────────────────────────────────────────────────────
// GET /api/profile — Get own profile
router.get('/profile', authenticate, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.email, u.first_name, u.last_name, u.phone, u.company_name,
              u.city, u.state, u.pincode, u.role, u.approval_status,
              u.profile_image_url, u.created_at
       FROM users u WHERE u.id = $1`,
      [req.user.id]
    );
    res.json({ success: true, data: { user: rows[0] } });
  } catch (err) {
    next(err);
  }
});

// ─── ADMIN ROUTES ─────────────────────────────────────────────────────────────
// All admin routes require authenticate + admin role
const adminAuth = [authenticate, authorize('admin')];

// GET /api/admin/stats — Dashboard statistics
router.get('/admin/stats', ...adminAuth, adminController.getStats);

// GET /api/admin/users — List all users
router.get('/admin/users', ...adminAuth, adminController.getUsers);

// POST /api/admin/users/:id/approve — Approve a user
router.post('/admin/users/:id/approve', ...adminAuth, adminController.approveUser);

// POST /api/admin/users/:id/reject — Reject a user
router.post('/admin/users/:id/reject',
  ...adminAuth,
  validate([body('reason').optional().trim()]),
  adminController.rejectUser
);

// POST /api/admin/users/:id/suspend
router.post('/admin/users/:id/suspend', ...adminAuth, adminController.toggleSuspend);

// POST /api/admin/users/:id/unsuspend
router.post('/admin/users/:id/unsuspend', ...adminAuth, adminController.toggleSuspend);

// GET /api/admin/audit-log
router.get('/admin/audit-log', ...adminAuth, adminController.getAuditLog);

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
// GET /api/health — Used by Google Cloud Run health checks
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'boothmarket-api' });
});

module.exports = router;
