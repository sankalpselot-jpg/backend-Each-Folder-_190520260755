/**
 * controllers/authController.js
 * 
 * Handles all authentication flows:
 * - Registration (all 3 roles + role-specific profile creation)
 * - Login with JWT access + refresh token pair
 * - Token refresh (silent re-auth without re-login)
 * - Logout (revoke refresh token)
 * - Password reset request + confirm
 */

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { query, transaction } = require('../config/database');
const emailService = require('../services/emailService');
const logger = require('../utils/logger');

// ─── Constants ────────────────────────────────────────────────────────────────
const BCRYPT_ROUNDS = 12;           // Cost factor — higher = slower brute-force
const RESET_TOKEN_EXPIRY_MS = 3600000; // 1 hour

// ─── JWT Helpers ──────────────────────────────────────────────────────────────
/**
 * Generate a short-lived access token (15 minutes).
 * Contains user ID — don't put sensitive data here.
 */
const generateAccessToken = (userId) =>
  jwt.sign({ userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',
  });

/**
 * Generate a long-lived refresh token (7 days).
 * Stored as a hash in DB for revocation support.
 */
const generateRefreshToken = (userId) =>
  jwt.sign({ userId }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  });

/**
 * Store a hashed refresh token in the database.
 * We store the hash (not the raw token) so even if DB is compromised,
 * tokens can't be reused.
 */
const storeRefreshToken = async (userId, token) => {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  await query(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [uuidv4(), userId, tokenHash, expiresAt]
  );
};

// ─── Register ─────────────────────────────────────────────────────────────────
/**
 * POST /api/auth/register
 * Creates user + role-specific profile in a single transaction.
 * Sends confirmation email. Account starts as 'pending' (admin must approve).
 */
const register = async (req, res, next) => {
  try {
    const {
      email, password, role, firstName, lastName,
      phone, companyName, city, state, pincode,
      // Consultant-specific
      bio, yearsExperience, specializations, productionHouseName, serviceCities,
      // Provider-specific
      warehouseAddress, deliveryRadiusKm, gstin,
      // Company-specific
      industry, numEventsPerYear,
    } = req.body;

    // Validate role is one of the 3 allowed registrant types (not 'admin')
    const allowedRoles = ['consultant', 'rental_provider', 'company'];
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid role. Must be: consultant, rental_provider, or company.',
      });
    }

    // Check email uniqueness
    const { rows: existing } = await query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );
    if (existing.length) {
      return res.status(409).json({
        success: false,
        message: 'An account with this email already exists.',
      });
    }

    // Hash password — never store plain text
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Create user + profile atomically (both or neither)
    const userId = await transaction(async (client) => {
      // 1. Insert into users table
      const { rows: [user] } = await client.query(
        `INSERT INTO users (
          id, email, password_hash, role, first_name, last_name,
          phone, company_name, city, state, pincode
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id`,
        [
          uuidv4(), email.toLowerCase().trim(), passwordHash, role,
          firstName, lastName, phone, companyName, city, state, pincode,
        ]
      );

      // 2. Insert role-specific profile
      if (role === 'consultant') {
        await client.query(
          `INSERT INTO consultant_profiles (id, user_id, bio, years_experience,
            specializations, production_house_name, service_cities)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            uuidv4(), user.id, bio, yearsExperience || null,
            specializations || [], productionHouseName, serviceCities || [],
          ]
        );
      } else if (role === 'rental_provider') {
        await client.query(
          `INSERT INTO rental_provider_profiles (id, user_id, bio,
            warehouse_address, delivery_radius_km, gstin)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            uuidv4(), user.id, bio, warehouseAddress,
            deliveryRadiusKm || 50, gstin,
          ]
        );
      } else if (role === 'company') {
        await client.query(
          `INSERT INTO company_profiles (id, user_id, industry, num_events_per_year)
           VALUES ($1, $2, $3, $4)`,
          [uuidv4(), user.id, industry, numEventsPerYear || null]
        );
      }

      return user.id;
    });

    // Send confirmation email (non-blocking — don't fail registration if email fails)
    emailService.sendRegistrationConfirmation({
      to: email,
      firstName,
      role,
    }).catch((err) => logger.warn('Registration email failed:', err.message));

    logger.info(`New ${role} registered: ${email} (id: ${userId})`);

    return res.status(201).json({
      success: true,
      message: 'Registration successful! Your account is under review. You will be notified by email within 24-48 hours.',
    });
  } catch (err) {
    next(err);
  }
};

// ─── Login ────────────────────────────────────────────────────────────────────
/**
 * POST /api/auth/login
 * Returns access token + refresh token on successful login.
 * Rejected/pending users get a clear message but no tokens.
 */
const login = async (req, res, next) => {
  try {
    const { email, password } = req.body;

    // Fetch user (case-insensitive email)
    const { rows } = await query(
      `SELECT id, email, password_hash, role, approval_status,
              first_name, last_name, company_name
       FROM users WHERE email = $1`,
      [email.toLowerCase().trim()]
    );

    if (!rows.length) {
      // Use generic message — don't confirm whether email exists (security)
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    const user = rows[0];

    // Compare provided password to stored hash
    const passwordValid = await bcrypt.compare(password, user.password_hash);
    if (!passwordValid) {
      return res.status(401).json({
        success: false,
        message: 'Invalid email or password.',
      });
    }

    // Allow admin and approved users only
    if (user.approval_status === 'rejected') {
      return res.status(403).json({
        success: false,
        message: 'Your account registration was not approved. Please contact support@boothmarket.com.',
        approvalStatus: 'rejected',
      });
    }

    if (user.approval_status === 'suspended') {
      return res.status(403).json({
        success: false,
        message: 'Your account has been suspended.',
        approvalStatus: 'suspended',
      });
    }

    // Generate tokens
    const accessToken = generateAccessToken(user.id);
    const refreshToken = generateRefreshToken(user.id);

    // Persist refresh token hash
    await storeRefreshToken(user.id, refreshToken);

    // Update last login timestamp
    await query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);

    logger.info(`Login: ${user.email} (${user.role})`);

    return res.json({
      success: true,
      data: {
        accessToken,
        refreshToken,
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          approvalStatus: user.approval_status,
          firstName: user.first_name,
          lastName: user.last_name,
          companyName: user.company_name,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── Token Refresh ────────────────────────────────────────────────────────────
/**
 * POST /api/auth/refresh
 * Silently issues a new access token using a valid refresh token.
 * Called automatically by the frontend when access token expires (401).
 */
const refreshToken = async (req, res, next) => {
  try {
    const { refreshToken: token } = req.body;

    if (!token) {
      return res.status(401).json({ success: false, message: 'Refresh token required.' });
    }

    // Verify signature
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_REFRESH_SECRET);
    } catch {
      return res.status(401).json({ success: false, message: 'Invalid or expired refresh token.' });
    }

    // Check token exists in DB (catches revoked tokens after logout)
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const { rows } = await query(
      `SELECT id FROM refresh_tokens
       WHERE user_id = $1 AND token_hash = $2 AND expires_at > NOW()`,
      [decoded.userId, tokenHash]
    );

    if (!rows.length) {
      return res.status(401).json({ success: false, message: 'Refresh token revoked or expired.' });
    }

    // Issue new access token
    const newAccessToken = generateAccessToken(decoded.userId);

    return res.json({ success: true, data: { accessToken: newAccessToken } });
  } catch (err) {
    next(err);
  }
};

// ─── Logout ───────────────────────────────────────────────────────────────────
/**
 * POST /api/auth/logout
 * Revokes the refresh token so it can never be reused.
 */
const logout = async (req, res, next) => {
  try {
    const { refreshToken: token } = req.body;

    if (token) {
      const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
      await query('DELETE FROM refresh_tokens WHERE token_hash = $1', [tokenHash]);
    }

    return res.json({ success: true, message: 'Logged out successfully.' });
  } catch (err) {
    next(err);
  }
};

// ─── Password Reset Request ───────────────────────────────────────────────────
/**
 * POST /api/auth/forgot-password
 * Generates a reset token and emails a link. Always returns 200 to prevent
 * email enumeration attacks (don't reveal whether email exists).
 */
const forgotPassword = async (req, res, next) => {
  try {
    const { email } = req.body;

    const { rows } = await query(
      'SELECT id, first_name, email FROM users WHERE email = $1',
      [email.toLowerCase().trim()]
    );

    if (rows.length) {
      const user = rows[0];
      const resetToken = crypto.randomBytes(32).toString('hex');
      const expiry = new Date(Date.now() + RESET_TOKEN_EXPIRY_MS);

      await query(
        'UPDATE users SET reset_token = $1, reset_token_expiry = $2 WHERE id = $3',
        [resetToken, expiry, user.id]
      );

      emailService.sendPasswordResetEmail({
        to: user.email,
        firstName: user.first_name,
        resetToken,
      }).catch((err) => logger.warn('Reset email failed:', err.message));
    }

    // Always return success (prevent email enumeration)
    return res.json({
      success: true,
      message: 'If an account exists with this email, a password reset link has been sent.',
    });
  } catch (err) {
    next(err);
  }
};

// ─── Password Reset Confirm ───────────────────────────────────────────────────
/**
 * POST /api/auth/reset-password
 * Verifies the reset token and updates the password.
 */
const resetPassword = async (req, res, next) => {
  try {
    const { token, newPassword } = req.body;

    const { rows } = await query(
      `SELECT id FROM users
       WHERE reset_token = $1 AND reset_token_expiry > NOW()`,
      [token]
    );

    if (!rows.length) {
      return res.status(400).json({
        success: false,
        message: 'Invalid or expired reset link. Please request a new one.',
      });
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    // Update password and clear the reset token
    await query(
      `UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expiry = NULL
       WHERE id = $2`,
      [passwordHash, rows[0].id]
    );

    // Invalidate all refresh tokens (force re-login everywhere)
    await query('DELETE FROM refresh_tokens WHERE user_id = $1', [rows[0].id]);

    return res.json({ success: true, message: 'Password updated successfully. Please log in.' });
  } catch (err) {
    next(err);
  }
};

module.exports = { register, login, refreshToken, logout, forgotPassword, resetPassword };
