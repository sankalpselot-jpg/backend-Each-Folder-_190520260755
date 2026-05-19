/**
 * controllers/adminController.js
 * 
 * Admin-only operations:
 * - View all pending registrations with filters
 * - Approve / reject users with email notification
 * - Platform-wide statistics dashboard
 * - Suspend / unsuspend accounts
 */

const { query } = require('../config/database');
const emailService = require('../services/emailService');
const logger = require('../utils/logger');

// ─── Get All Users (Admin Dashboard) ─────────────────────────────────────────
/**
 * GET /api/admin/users
 * Returns paginated list of users with optional filters.
 * Query params: ?role=consultant&status=pending&search=john&page=1
 */
const getUsers = async (req, res, next) => {
  try {
    const {
      role, status, search,
      page = 1, limit = 25,
      sortBy = 'created_at', sortOrder = 'DESC',
    } = req.query;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    const conditions = ['u.role != $1']; // Never show admin accounts in this list
    const params = ['admin'];
    let paramIndex = 2;

    if (role) {
      conditions.push(`u.role = $${paramIndex}`);
      params.push(role);
      paramIndex++;
    }

    if (status) {
      conditions.push(`u.approval_status = $${paramIndex}`);
      params.push(status);
      paramIndex++;
    }

    if (search) {
      conditions.push(
        `(LOWER(u.first_name) LIKE $${paramIndex} OR LOWER(u.last_name) LIKE $${paramIndex}
          OR LOWER(u.email) LIKE $${paramIndex} OR LOWER(u.company_name) LIKE $${paramIndex})`
      );
      params.push(`%${search.toLowerCase()}%`);
      paramIndex++;
    }

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    const { rows: users } = await query(
      `SELECT
        u.id, u.email, u.first_name, u.last_name, u.company_name,
        u.role, u.approval_status, u.phone, u.city, u.state,
        u.created_at, u.last_login_at,
        -- Count their products (for rental providers)
        (SELECT COUNT(*) FROM products p WHERE p.provider_id = u.id) AS product_count
       FROM users u
       ${whereClause}
       ORDER BY u.${['created_at','first_name','email','role'].includes(sortBy) ? sortBy : 'created_at'}
                ${sortOrder === 'ASC' ? 'ASC' : 'DESC'}
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limitNum, offset]
    );

    const { rows: countRows } = await query(
      `SELECT COUNT(*) FROM users u ${whereClause}`,
      params
    );

    const total = parseInt(countRows[0].count);

    return res.json({
      success: true,
      data: {
        users,
        pagination: {
          total, page: pageNum, limit: limitNum,
          totalPages: Math.ceil(total / limitNum),
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── Approve User ─────────────────────────────────────────────────────────────
/**
 * POST /api/admin/users/:id/approve
 * Approves a pending user and sends them a welcome email.
 */
const approveUser = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { rows } = await query(
      'SELECT id, email, first_name, last_name, role, approval_status FROM users WHERE id = $1',
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const user = rows[0];

    if (user.approval_status === 'approved') {
      return res.status(400).json({ success: false, message: 'User is already approved.' });
    }

    // Update status
    await query(
      'UPDATE users SET approval_status = $1 WHERE id = $2',
      ['approved', id]
    );

    // Audit log
    await query(
      'INSERT INTO admin_actions (id, admin_id, target_user_id, action) VALUES (gen_random_uuid(), $1, $2, $3)',
      [req.user.id, id, 'approved']
    );

    // Send approval email (non-blocking)
    emailService.sendApprovalEmail({
      to: user.email,
      firstName: user.first_name,
      role: user.role,
    }).catch((err) => logger.warn('Approval email failed:', err.message));

    logger.info(`Admin ${req.user.id} approved user ${id} (${user.email})`);

    return res.json({
      success: true,
      message: `${user.first_name} ${user.last_name} has been approved. Notification email sent.`,
    });
  } catch (err) {
    next(err);
  }
};

// ─── Reject User ──────────────────────────────────────────────────────────────
/**
 * POST /api/admin/users/:id/reject
 * Rejects a user with a reason. Sends rejection email.
 * Body: { reason: "Incomplete business information" }
 */
const rejectUser = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;

    const { rows } = await query(
      'SELECT id, email, first_name, approval_status FROM users WHERE id = $1',
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'User not found.' });
    }

    const user = rows[0];

    await query(
      'UPDATE users SET approval_status = $1 WHERE id = $2',
      ['rejected', id]
    );

    await query(
      'INSERT INTO admin_actions (id, admin_id, target_user_id, action, reason) VALUES (gen_random_uuid(), $1, $2, $3, $4)',
      [req.user.id, id, 'rejected', reason]
    );

    emailService.sendRejectionEmail({
      to: user.email,
      firstName: user.first_name,
      reason,
    }).catch((err) => logger.warn('Rejection email failed:', err.message));

    logger.info(`Admin ${req.user.id} rejected user ${id}`);

    return res.json({ success: true, message: 'User rejected and notified.' });
  } catch (err) {
    next(err);
  }
};

// ─── Suspend / Unsuspend ──────────────────────────────────────────────────────
/**
 * POST /api/admin/users/:id/suspend
 * POST /api/admin/users/:id/unsuspend
 * Immediately blocks/restores access.
 */
const toggleSuspend = async (req, res, next) => {
  try {
    const { id } = req.params;
    const suspend = req.path.includes('suspend') && !req.path.includes('unsuspend');
    const newStatus = suspend ? 'suspended' : 'approved';

    const { rows } = await query('SELECT id, email, first_name FROM users WHERE id = $1', [id]);
    if (!rows.length) return res.status(404).json({ success: false, message: 'User not found.' });

    await query('UPDATE users SET approval_status = $1 WHERE id = $2', [newStatus, id]);

    await query(
      'INSERT INTO admin_actions (id, admin_id, target_user_id, action) VALUES (gen_random_uuid(), $1, $2, $3)',
      [req.user.id, id, suspend ? 'suspended' : 'unsuspended']
    );

    return res.json({
      success: true,
      message: `User ${suspend ? 'suspended' : 'unsuspended'} successfully.`,
    });
  } catch (err) {
    next(err);
  }
};

// ─── Platform Statistics ──────────────────────────────────────────────────────
/**
 * GET /api/admin/stats
 * Dashboard numbers for the admin home page.
 */
const getStats = async (req, res, next) => {
  try {
    const { rows: userStats } = await query(`
      SELECT
        COUNT(*) FILTER (WHERE role = 'consultant') AS total_consultants,
        COUNT(*) FILTER (WHERE role = 'rental_provider') AS total_providers,
        COUNT(*) FILTER (WHERE role = 'company') AS total_companies,
        COUNT(*) FILTER (WHERE approval_status = 'pending') AS pending_approvals,
        COUNT(*) FILTER (WHERE approval_status = 'approved') AS approved_users,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS new_this_week
      FROM users WHERE role != 'admin'
    `);

    const { rows: productStats } = await query(`
      SELECT
        COUNT(*) AS total_products,
        COUNT(*) FILTER (WHERE status = 'active') AS active_products,
        AVG(price_per_day) AS avg_price_per_day
      FROM products
    `);

    const { rows: inquiryStats } = await query(`
      SELECT
        COUNT(*) AS total_inquiries,
        COUNT(*) FILTER (WHERE status = 'pending') AS pending_inquiries,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days') AS inquiries_this_week
      FROM inquiries
    `);

    return res.json({
      success: true,
      data: {
        users: userStats[0],
        products: productStats[0],
        inquiries: inquiryStats[0],
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── Get Audit Log ────────────────────────────────────────────────────────────
/**
 * GET /api/admin/audit-log
 * Returns admin action history for accountability.
 */
const getAuditLog = async (req, res, next) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    const { rows } = await query(
      `SELECT
        aa.id, aa.action, aa.reason, aa.created_at,
        admin.first_name AS admin_first_name, admin.last_name AS admin_last_name,
        target.first_name AS target_first_name, target.last_name AS target_last_name,
        target.email AS target_email, target.role AS target_role
       FROM admin_actions aa
       JOIN users admin ON aa.admin_id = admin.id
       JOIN users target ON aa.target_user_id = target.id
       ORDER BY aa.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limitNum, offset]
    );

    return res.json({ success: true, data: { actions: rows } });
  } catch (err) {
    next(err);
  }
};

module.exports = { getUsers, approveUser, rejectUser, toggleSuspend, getStats, getAuditLog };
