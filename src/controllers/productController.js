/**
 * controllers/productController.js
 * 
 * Rental product lifecycle management:
 * - Rental providers: create, update, delete their listings
 * - All approved users: search, filter, view products
 * - Image upload to Google Cloud Storage
 * - Availability calendar management
 */

const { v4: uuidv4 } = require('uuid');
const { query, transaction } = require('../config/database');
const { validateImage, uploadProductImage, deleteProductImage, deleteAllProductImages } = require('../services/storageService');
const { handleUpload, uploadProductImages } = require('../middleware/upload');
const logger = require('../utils/logger');

// ─── Create Product ───────────────────────────────────────────────────────────
/**
 * POST /api/products
 * Rental providers only. Creates a new listing with images.
 * Images are uploaded to GCS and URLs stored in product_images table.
 */
const createProduct = async (req, res, next) => {
  try {
    // Process multipart form data (images + fields)
    await handleUpload(uploadProductImages)(req, res);

    const {
      categoryId, title, description,
      pricePerDay, securityDeposit, minimumRentalDays,
      deliveryTimeDays, deliveryRadiusKm, deliveryCharge,
      lengthCm, widthCm, heightCm, weightKg,
      stockQuantity, tags, city, state,
    } = req.body;

    // Validate required fields
    if (!title || !description || !categoryId || !pricePerDay) {
      return res.status(400).json({
        success: false,
        message: 'Title, description, category, and price per day are required.',
      });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'At least one product image is required.',
      });
    }

    const productId = uuidv4();
    const uploadedImages = [];

    // Upload each image to GCS
    for (const file of req.files) {
      validateImage(file); // Throws if invalid type/size
      const { publicUrl, objectName } = await uploadProductImage(
        file.buffer,
        file.mimetype,
        productId
      );
      uploadedImages.push({ publicUrl, objectName });
    }

    // Save product + images in a single transaction
    await transaction(async (client) => {
      // Insert product record
      await client.query(
        `INSERT INTO products (
          id, provider_id, category_id, title, description,
          price_per_day, security_deposit, minimum_rental_days,
          delivery_time_days, delivery_radius_km, delivery_charge,
          length_cm, width_cm, height_cm, weight_kg,
          stock_quantity, tags, city, state
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
        )`,
        [
          productId, req.user.id, categoryId, title, description,
          pricePerDay, securityDeposit || 0, minimumRentalDays || 1,
          deliveryTimeDays || 1, deliveryRadiusKm, deliveryCharge || 0,
          lengthCm, widthCm, heightCm, weightKg,
          stockQuantity || 1,
          tags ? (Array.isArray(tags) ? tags : [tags]) : [],
          city, state,
        ]
      );

      // Insert image records (first image = primary, display_order = 0)
      for (let i = 0; i < uploadedImages.length; i++) {
        await client.query(
          `INSERT INTO product_images (id, product_id, image_url, gcs_object_name, display_order)
           VALUES ($1, $2, $3, $4, $5)`,
          [uuidv4(), productId, uploadedImages[i].publicUrl, uploadedImages[i].objectName, i]
        );
      }
    });

    logger.info(`Product created: ${productId} by provider ${req.user.id}`);

    return res.status(201).json({
      success: true,
      message: 'Product listed successfully.',
      data: { productId },
    });
  } catch (err) {
    next(err);
  }
};

// ─── Search / List Products ───────────────────────────────────────────────────
/**
 * GET /api/products
 * Public search with filters. Supports:
 *   - ?search=LED      → full-text search on title/description
 *   - ?categoryId=3    → filter by category
 *   - ?city=Mumbai     → filter by city
 *   - ?minPrice=100    → min price per day
 *   - ?maxPrice=500    → max price per day
 *   - ?page=1&limit=20 → pagination
 */
const getProducts = async (req, res, next) => {
  try {
    const {
      search, categoryId, city, state,
      minPrice, maxPrice,
      page = 1, limit = 20,
      sortBy = 'created_at', sortOrder = 'DESC',
    } = req.query;

    // Sanitize pagination values
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit))); // Cap at 50 per page
    const offset = (pageNum - 1) * limitNum;

    // Build dynamic WHERE clause
    const conditions = [`p.status = 'active'`];
    const params = [];
    let paramIndex = 1;

    if (search) {
      // PostgreSQL full-text search using the GIN index
      conditions.push(
        `to_tsvector('english', p.title || ' ' || p.description) @@ plainto_tsquery('english', $${paramIndex})`
      );
      params.push(search);
      paramIndex++;
    }

    if (categoryId) {
      conditions.push(`p.category_id = $${paramIndex}`);
      params.push(parseInt(categoryId));
      paramIndex++;
    }

    if (city) {
      conditions.push(`LOWER(p.city) = LOWER($${paramIndex})`);
      params.push(city);
      paramIndex++;
    }

    if (state) {
      conditions.push(`LOWER(p.state) = LOWER($${paramIndex})`);
      params.push(state);
      paramIndex++;
    }

    if (minPrice) {
      conditions.push(`p.price_per_day >= $${paramIndex}`);
      params.push(parseFloat(minPrice));
      paramIndex++;
    }

    if (maxPrice) {
      conditions.push(`p.price_per_day <= $${paramIndex}`);
      params.push(parseFloat(maxPrice));
      paramIndex++;
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // Whitelist sort columns to prevent SQL injection
    const allowedSortCols = ['created_at', 'price_per_day', 'view_count', 'inquiry_count'];
    const safeSortBy = allowedSortCols.includes(sortBy) ? sortBy : 'created_at';
    const safeSortOrder = sortOrder.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

    // Main query with provider info and primary image
    const { rows: products } = await query(
      `SELECT
        p.id, p.title, p.description, p.price_per_day, p.security_deposit,
        p.minimum_rental_days, p.delivery_time_days, p.delivery_radius_km,
        p.stock_quantity, p.city, p.state, p.tags, p.view_count, p.inquiry_count,
        p.created_at,
        pc.name AS category_name, pc.slug AS category_slug,
        u.first_name AS provider_first_name, u.last_name AS provider_last_name,
        u.company_name AS provider_company,
        u.city AS provider_city,
        -- Subquery to get primary image only (display_order = 0)
        (SELECT image_url FROM product_images
         WHERE product_id = p.id ORDER BY display_order LIMIT 1) AS primary_image
       FROM products p
       JOIN product_categories pc ON p.category_id = pc.id
       JOIN users u ON p.provider_id = u.id
       ${whereClause}
       ORDER BY p.${safeSortBy} ${safeSortOrder}
       LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
      [...params, limitNum, offset]
    );

    // Count total matching records for pagination metadata
    const { rows: countRows } = await query(
      `SELECT COUNT(*) FROM products p ${whereClause}`,
      params
    );

    const total = parseInt(countRows[0].count);

    // Increment view count asynchronously (fire-and-forget)
    // Don't await this — it's analytics, not critical
    if (products.length === 1 && req.query.id) {
      query('UPDATE products SET view_count = view_count + 1 WHERE id = $1', [req.query.id])
        .catch(() => {});
    }

    return res.json({
      success: true,
      data: {
        products,
        pagination: {
          total,
          page: pageNum,
          limit: limitNum,
          totalPages: Math.ceil(total / limitNum),
          hasNext: pageNum < Math.ceil(total / limitNum),
          hasPrev: pageNum > 1,
        },
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── Get Single Product ───────────────────────────────────────────────────────
/**
 * GET /api/products/:id
 * Returns full product details including all images and availability.
 */
const getProductById = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { rows } = await query(
      `SELECT
        p.*,
        pc.name AS category_name, pc.slug AS category_slug,
        u.first_name AS provider_first_name, u.last_name AS provider_last_name,
        u.company_name AS provider_company, u.city AS provider_city,
        u.phone AS provider_phone
       FROM products p
       JOIN product_categories pc ON p.category_id = pc.id
       JOIN users u ON p.provider_id = u.id
       WHERE p.id = $1 AND p.status = 'active'`,
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Product not found.' });
    }

    const product = rows[0];

    // Get all images ordered by display position
    const { rows: images } = await query(
      'SELECT id, image_url, alt_text, display_order FROM product_images WHERE product_id = $1 ORDER BY display_order',
      [id]
    );

    // Get blocked dates for availability calendar (next 6 months)
    const { rows: blockedDates } = await query(
      `SELECT blocked_date FROM product_availability
       WHERE product_id = $1 AND blocked_date >= CURRENT_DATE
       ORDER BY blocked_date`,
      [id]
    );

    // Increment view count (analytics)
    query('UPDATE products SET view_count = view_count + 1 WHERE id = $1', [id]).catch(() => {});

    return res.json({
      success: true,
      data: {
        ...product,
        images,
        blockedDates: blockedDates.map((r) => r.blocked_date),
      },
    });
  } catch (err) {
    next(err);
  }
};

// ─── Update Product ───────────────────────────────────────────────────────────
/**
 * PUT /api/products/:id
 * Rental provider can update their own listing.
 * Cannot update another provider's product.
 */
const updateProduct = async (req, res, next) => {
  try {
    const { id } = req.params;

    // Verify ownership
    const { rows } = await query(
      'SELECT id, provider_id FROM products WHERE id = $1',
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Product not found.' });
    }

    if (rows[0].provider_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'You can only update your own products.',
      });
    }

    const {
      title, description, categoryId, pricePerDay, securityDeposit,
      minimumRentalDays, deliveryTimeDays, deliveryRadiusKm, deliveryCharge,
      lengthCm, widthCm, heightCm, weightKg, stockQuantity, tags, city, state, status,
    } = req.body;

    await query(
      `UPDATE products SET
        title = COALESCE($1, title),
        description = COALESCE($2, description),
        category_id = COALESCE($3, category_id),
        price_per_day = COALESCE($4, price_per_day),
        security_deposit = COALESCE($5, security_deposit),
        minimum_rental_days = COALESCE($6, minimum_rental_days),
        delivery_time_days = COALESCE($7, delivery_time_days),
        delivery_radius_km = COALESCE($8, delivery_radius_km),
        delivery_charge = COALESCE($9, delivery_charge),
        length_cm = COALESCE($10, length_cm),
        width_cm = COALESCE($11, width_cm),
        height_cm = COALESCE($12, height_cm),
        weight_kg = COALESCE($13, weight_kg),
        stock_quantity = COALESCE($14, stock_quantity),
        tags = COALESCE($15, tags),
        city = COALESCE($16, city),
        state = COALESCE($17, state),
        status = COALESCE($18, status)
       WHERE id = $19`,
      [
        title, description, categoryId, pricePerDay, securityDeposit,
        minimumRentalDays, deliveryTimeDays, deliveryRadiusKm, deliveryCharge,
        lengthCm, widthCm, heightCm, weightKg, stockQuantity,
        tags ? (Array.isArray(tags) ? tags : [tags]) : null,
        city, state, status, id,
      ]
    );

    return res.json({ success: true, message: 'Product updated successfully.' });
  } catch (err) {
    next(err);
  }
};

// ─── Delete Product ───────────────────────────────────────────────────────────
/**
 * DELETE /api/products/:id
 * Deletes the product record + all images from GCS.
 * Only the owning provider can delete.
 */
const deleteProduct = async (req, res, next) => {
  try {
    const { id } = req.params;

    const { rows } = await query(
      'SELECT id, provider_id FROM products WHERE id = $1',
      [id]
    );

    if (!rows.length) {
      return res.status(404).json({ success: false, message: 'Product not found.' });
    }

    if (rows[0].provider_id !== req.user.id) {
      return res.status(403).json({
        success: false,
        message: 'You can only delete your own products.',
      });
    }

    // Delete all GCS images first (before DB row is gone)
    await deleteAllProductImages(id);

    // DB row deletion cascades to product_images, product_availability
    await query('DELETE FROM products WHERE id = $1', [id]);

    return res.json({ success: true, message: 'Product deleted successfully.' });
  } catch (err) {
    next(err);
  }
};

// ─── Update Availability ──────────────────────────────────────────────────────
/**
 * POST /api/products/:id/availability
 * Provider sets blocked dates on their product calendar.
 * Body: { blockedDates: ['2025-03-01', '2025-03-02', ...] }
 */
const updateAvailability = async (req, res, next) => {
  try {
    const { id } = req.params;
    const { blockedDates, action } = req.body; // action: 'block' | 'unblock'

    if (!Array.isArray(blockedDates) || blockedDates.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'blockedDates must be a non-empty array of date strings (YYYY-MM-DD).',
      });
    }

    // Verify ownership
    const { rows } = await query(
      'SELECT provider_id FROM products WHERE id = $1',
      [id]
    );

    if (!rows.length || rows[0].provider_id !== req.user.id) {
      return res.status(403).json({ success: false, message: 'Unauthorized.' });
    }

    if (action === 'unblock') {
      // Remove blocked dates
      await query(
        'DELETE FROM product_availability WHERE product_id = $1 AND blocked_date = ANY($2::date[])',
        [id, blockedDates]
      );
    } else {
      // Block dates (INSERT ... ON CONFLICT DO NOTHING = idempotent)
      for (const date of blockedDates) {
        await query(
          `INSERT INTO product_availability (id, product_id, blocked_date)
           VALUES ($1, $2, $3) ON CONFLICT (product_id, blocked_date) DO NOTHING`,
          [uuidv4(), id, date]
        );
      }
    }

    return res.json({ success: true, message: `Dates ${action}ed successfully.` });
  } catch (err) {
    next(err);
  }
};

// ─── Get Provider's Own Listings ──────────────────────────────────────────────
/**
 * GET /api/products/my-listings
 * Returns the authenticated rental provider's own products.
 */
const getMyListings = async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT p.id, p.title, p.price_per_day, p.stock_quantity, p.status,
              p.view_count, p.inquiry_count, p.created_at,
              pc.name AS category_name,
              (SELECT image_url FROM product_images
               WHERE product_id = p.id ORDER BY display_order LIMIT 1) AS primary_image
       FROM products p
       JOIN product_categories pc ON p.category_id = pc.id
       WHERE p.provider_id = $1
       ORDER BY p.created_at DESC`,
      [req.user.id]
    );

    return res.json({ success: true, data: { products: rows } });
  } catch (err) {
    next(err);
  }
};

module.exports = {
  createProduct, getProducts, getProductById,
  updateProduct, deleteProduct, updateAvailability, getMyListings,
};
