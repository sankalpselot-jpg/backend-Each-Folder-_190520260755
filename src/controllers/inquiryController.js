/**
 * controllers/inquiryController.js
 * 
 * Handles the core marketplace transaction flow:
 * 1. Consultant sends an inquiry for a product
 * 2. Provider receives email notification
 * 3. Provider responds (accept/decline) with message
 * 4. Consultant receives email notification of response
 * 
 * No payment at this stage — inquiry is a lead/request system.
 */

const { v4: uuidv4 } = require('uuid');
const { query } = require('../config/database');
const emailService = require('../services/emailService');
const logger = require('../utils/logger');

// ─── Create Inquiry ───────────────────────────────────────────────────────────
/**
 * POST /api/inquiries
 * Consultants only. Sends an inquiry to a rental provider for a product.
 */
const createInquiry = async (req, res, next) => {
  try {
    const {
      productId, eventName, eventCity,
      rentalStartDate, rentalEndDate,
      quantityNeeded, consultantMessage,
    } = req.body;

    if (!productId || !rentalStartDate || !rentalEndDate || !consultantMessage) {
      return res.status(400).json({
        success: false,
        message: 'Product, rental dates, and message are required.',
      });
    }

    // Validate date range
    const startDate = new Date(rentalStartDate);
    const endDate = new Date(rentalEndDate);
    if (startDate >= endDate) {
      return res.status(400).json({
        success: false,
        message: 'End date must be after start date.',
      });
    }

    if (startDate < new Date()) {
      return res.status(400).json({
        success: false,
        message: 'Rental start date cannot be in the past.',
      });
    }

    // Fetch product + provider info
    const { rows: products } = await query(
      `SELECT p.id, p.title, p.provider_id, p.price_per_day, p.minimum_rental_days,
              p.stock_quantity, p.status,
              u.first_name AS provider_first_name, u.last_name AS provider_last_name,
              u.email AS provider_email
       FROM products p
       JOIN users u ON p.provider_id = u.id
       WHERE p.id = $1`,
      [productId]
    );

    if (!products.length) {
      return res.status(404).json({ success: false, message: 'Product not found.' });
    }

    const product = products[0];

    if (product.status !== 'active') {
      return res.status(400).json({
        success: false,
        message: 'This product is not currently available for rental.',
      });
    }

    // Prevent consultant from inquiring on their own products (edge case)
    if (product.provider_id === req.user.id) {
      return res.status(400).json({
        success: false,
        message: 'You cannot send an inquiry for your own product.',
      });
    }

    // Check for blocked dates in the requested range
    const { rows: blockedDates } = await query(
      `SELECT COUNT(*) AS blocked_count
       FROM product_availability
       WHERE product_id = $1
         AND blocked_date BETWEEN $2 AND $3`,
      [productId, rentalStartDate, rentalEndDate]
    );

    if (parseInt(blockedDates[0].blocked_count) > 0) {
      return res.status(400).json({
        success: false,
        message: 'The product is not available for some dates in your requested range. Please check the availability calendar.',
      });
    }

    // Calculate rental days and estimated total
    const rentalDays = Math.ceil(
      (endDate - startDate) / (1000 * 60 * 60 * 24)
    ) + 1;
    const qty = quantityNeeded || 1;
    const estimatedTotal = product.price_per_day * rentalDays * qty;

    // Create the inquiry
    const inquiryId = uuidv4();
    await query(
      `INSERT INTO inquiries (
        id, product_id, consultant_id, provider_id, status,
        event_name, event_city, rental_start_date, rental_end_date,
        quantity_needed, consultant_message, estimated_total
      ) VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9,$10,$11)`,
      [
        inquiryId, productId, req.user.id, product.provider_id,
        eventName, eventCity, rentalStartDate, rentalEndDate,
        qty, consultantMessage, estimatedTotal,
      ]
    );

    // Increment product's inquiry count (analytics)
    query('UPDATE products SET inquiry_count = inquiry_count + 1 WHERE id = $1', [productId])
      .catch(() => {});

    // Notify the rental provider by email (non-blocking)
    emailService.sendInquiryNotificationToProvider({
      to: product.provider_email,
      providerName: product.provider_first_name,
      consultantName: `${req.user.firstName} ${req.user.lastName}`,
      productTitle: product.title,
      inquiryId,
    }).catch((err) => logger.warn('Inquiry notification email failed:', err.message));

    logger.info(`Inquiry ${inquiryId} created by consultant ${req.user.id} for product ${productId}`);

    return res.status(201).json({
      success: true,
      message: 'Inquiry sent successfully! The provider will respond within 48 hours.',
      data: {
        inquiryId,
        estimatedTotal,
        rentalDays,
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── Get My Inquiries ─────────────────────────────────────────────────────────
/**
 * GET /api/inquiries
 * Returns inquiries relevant to the authenticated user:
 * - Consultants: inquiries they sent
 * - Providers: inquiries they received
 */
const getMyInquiries = async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit)));
    const offset = (pageNum - 1) * limitNum;

    // Filter by role
    const roleFilter = req.user.role === 'consultant'
      ? 'i.consultant_id = $1'
      : 'i.provider_id = $1';

    const params = [req.user.id];
    let paramIndex = 2;
    let statusClause = '';

    if (status) {
      statusClause = ` AND i.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    const { rows: inquiries } = await query(
      `SELECT
        i.id, i.product_id, i.status, i.event_name, i.event_city,
        i.rental_start_date, i.rental_end_date,
        i.quantity_needed, i.rental_days, i.estimated_total,
        i.consultant_message, i.provider_response, i.responded_at,
        i.created_at,
        p.title AS product_title, p.price_per_day,
        (SELECT image_url FROM product_images WHERE product_id = p.id ORDER BY display_order LIMIT 1) AS product_image,
        c.first_name AS consultant_first_name, c.last_name AS consultant_last_name,
        c.company_name AS consultant_company,
        pr.first_name AS provider_first_name, pr.last_name AS provider_last_name,
        pr.company_name AS provider_company
       FROM inquiries i
       JOIN products p ON i.product_id = p.id
       JOIN users c ON i.consultant_id = c.id
       JOIN users pr ON i.provider_id = pr.id
       WHERE ${roleFilter}${statusClause}
       ORDER BY i.created_at DESC
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limitNum, offset]
    );

    const { rows: countRows } = await query(
      `SELECT COUNT(*) FROM inquiries i WHERE ${roleFilter}${statusClause}`,
      params
    );

    return res.json({
      success: true,
      data: {
        inquiries,
        pagination: {
          total: parseInt(countRows[0].count),
          page: pageNum,
          limit: limitNum,
          totalPages: Math.ceil(parseInt(countRows[0].count) / limitNum),
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── Respond to Inquiry ───────────────────────────────────────────────────────
/**
 * POST /api/inquiries/:id/respond
 * Rental providers only. Accept or decline with a message.
 * Body: { status: 'accepted' | 'declined', response: "..." }
 */
const respondToInquiry = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { status, response: providerResponse } = req.body;

    if (!['accepted', 'declined'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Status must be "accepted" or "declined".',
      });
    }

    // Fetch inquiry with consultant info for email
    const { rows } = await query(
      `SELECT i.id, i.provider_id, i.consultant_id, i.status AS current_status,
              p.title AS product_title,
              c.email AS consultant_email, c.first_name AS consultant_first_name,
              pr.first_name AS provider_first_name
       FROM inquiries i
       JOIN products p ON i.product_id = p.id
       JOIN users c ON i.consultant_id = c.id
       JOIN users pr ON i.provider_id = pr.id
       WHERE i.id = $1`,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Inquiry not found.' });
    }

    const inquiry = rows[0];

    // Only the intended provider can respond
    if (inquiry.provider_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'You can only respond to inquiries sent to you.',
      });
    }

    if (inquiry.current_status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'This inquiry has already been responded to.',
      });
    }

    // Update inquiry with response
    await query(
      `UPDATE inquiries SET
        status = $1, provider_response = $2, responded_at = NOW()
       WHERE id = $3`,
      [status, providerResponse, id]
    );

    // Notify consultant
    emailService.sendInquiryResponseToConsultant({
      to: inquiry.consultant_email,
      consultantName: inquiry.consultant_first_name,
      providerName: inquiry.provider_first_name,
      productTitle: inquiry.product_title,
      inquiryId: id,
      status,
    }).catch((err) => logger.warn('Inquiry response email failed:', err.message));

    return res.json({
      success: true,
      message: `Inquiry ${status}. The consultant has been notified.`,
    });
  } catch (err) {
    next(err);
  }
};

// ─── Cancel Inquiry ───────────────────────────────────────────────────────────
/**
 * POST /api/inquiries/:id/cancel
 * Consultant can cancel a pending inquiry they sent.
 */
const cancelInquiry = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { rows } = await query(
      'SELECT id, consultant_id, status FROM inquiries WHERE id = $1',
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Inquiry not found.' });
    }

    if (rows[0].consultant_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Unauthorized.' });
    }

    if (rows[0].status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Only pending inquiries can be cancelled.',
      });
    }

    await query("UPDATE inquiries SET status = 'cancelled' WHERE id = $1", [id]);

    return res.json({ success: true, message: 'Inquiry cancelled successfully.' });
  } catch (err) {
    next(err);
  }
};

module.exports = { createInquiry, getMyInquiries, respondToInquiry, cancelInquiry };
