/**
 * middleware/auth.js
 * 
 * JWT Authentication & Role-Based Access Control (RBAC) middleware.
 * 
 * Usage in routes:
 *   router.get('/products', authenticate, authorize('consultant', 'company'), handler)
 *   router.post('/admin/approve', authenticate, authorize('admin'), handler)
 */

const jwt = require('jsonwebtoken');
const { query } = require('../config/database');
const logger = require('../utils/logger');

// ─── Token Verification ───────────────────────────────────────────────────────
/**
 * authenticate — verifies the JWT access token from the Authorization header.
 * 
 * Attaches `req.user` with { id, email, role, approvalStatus } on success.
 * Rejects with 401 if token is missing, expired, or tampered.
 */
const authenticate = async (req, res, next) => {
  try {
    // Extract token from "Bearer <token>" header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required. Please log in.',
      });
    }

    const token = authHeader.split(' ')[1];

    // Verify signature and expiry
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      if (err.name === 'TokenExpiredError') {
        return res.status(401).json({
          success: false,
          message: 'Session expired. Please log in again.',
          code: 'TOKEN_EXPIRED',
        });
      }
      return res.status(401).json({
        success: false,
        message: 'Invalid authentication token.',
      });
    }

    // Fetch fresh user data (catches deactivated/suspended accounts mid-session)
    const { rows } = await query(
      'SELECT id, email, role, approval_status, first_name, last_name FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (!rows.length) {
      return res.status(401).json({
        success: false,
        message: 'User account not found.',
      });
    }

    const user = rows[0];

    // Block suspended users immediately
    if (user.approval_status === 'suspended') {
      return res.status(403).json({
        success: false,
        message: 'Your account has been suspended. Contact support@boothmarket.com.',
      });
    }

    // Attach user to request for downstream handlers
    req.user = {
      id: user.id,
      email: user.email,
      role: user.role,
      approvalStatus: user.approval_status,
      firstName: user.first_name,
      lastName: user.last_name,
    };

    next();
  } catch (err) {
    logger.error('Authentication middleware error:', err);
    return res.status(500).json({
      success: false,
      message: 'Authentication error. Please try again.',
    });
  }
};

// ─── Role-Based Access Control ────────────────────────────────────────────────
/**
 * authorize(...roles) — factory that returns middleware checking user role.
 * Must be used AFTER authenticate.
 * 
 * Example:
 *   authorize('admin')                      → only admins
 *   authorize('consultant', 'company')      → consultants or companies
 */
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Authentication required.',
      });
    }

    if (!roles.includes(req.user.role)) {
      logger.warn(`Unauthorized access attempt`, {
        userId: req.user.id,
        userRole: req.user.role,
        requiredRoles: roles,
        path: req.path,
      });
      return res.status(403).json({
        success: false,
        message: 'You do not have permission to perform this action.',
      });
    }

    next();
  };
};

// ─── Approved Users Only ──────────────────────────────────────────────────────
/**
 * requireApproved — blocks pending/rejected users from accessing protected routes.
 * Admins are always allowed through.
 * Must be used AFTER authenticate.
 */
const requireApproved = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Authentication required.' });
  }

  // Admins bypass approval check
  if (req.user.role === 'admin') return next();

  if (req.user.approvalStatus !== 'approved') {
    return res.status(403).json({
      success: false,
      message: 'Your account is pending admin approval. You will be notified by email.',
      approvalStatus: req.user.approvalStatus,
    });
  }

  next();
};

module.exports = { authenticate, authorize, requireApproved };
