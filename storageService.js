/**
 * services/storageService.js
 *
 * Google Cloud Storage integration for product images.
 * Falls back gracefully if GCS is not configured (Railway deployment).
 * When GCS_BUCKET_NAME is not set, image upload returns a placeholder URL.
 */

const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

// ─── Check if GCS is configured ──────────────────────────────────────────────
// On Railway without GCS setup, we skip GCS initialization entirely
// to prevent server crash on startup
const GCS_ENABLED = !!(process.env.GCS_BUCKET_NAME && process.env.GOOGLE_CLOUD_PROJECT);

let storage = null;
let bucket = null;

if (GCS_ENABLED) {
  try {
    const { Storage } = require('@google-cloud/storage');
    storage = new Storage({ projectId: process.env.GOOGLE_CLOUD_PROJECT });
    bucket = storage.bucket(process.env.GCS_BUCKET_NAME);
    logger.info('Google Cloud Storage initialized successfully');
  } catch (err) {
    logger.warn('GCS initialization failed — image upload disabled:', err.message);
  }
} else {
  logger.warn('GCS_BUCKET_NAME not set — image upload will use placeholder URLs');
}

// ─── Allowed MIME Types ───────────────────────────────────────────────────────
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE_MB = 5;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

/**
 * Validate that a file is a safe image type and within size limits.
 */
const validateImage = (file) => {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    throw new Error('Invalid file type. Allowed: JPG, PNG, WebP');
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(`File too large. Maximum size: ${MAX_FILE_SIZE_MB}MB`);
  }
};

/**
 * Upload a single image buffer to Google Cloud Storage.
 * Falls back to a placeholder URL if GCS is not configured.
 */
const uploadProductImage = async (buffer, mimetype, productId) => {
  // If GCS not configured, return a placeholder image URL
  if (!GCS_ENABLED || !bucket) {
    logger.warn('GCS not configured - using placeholder image URL');
    const placeholderUrl = `https://placehold.co/600x400?text=Product+Image`;
    const objectName = `products/${productId}/${uuidv4()}.jpg`;
    return { publicUrl: placeholderUrl, objectName };
  }

  const ext = mimetype.split('/')[1].replace('jpeg', 'jpg');
  const objectName = `products/${productId}/${uuidv4()}.${ext}`;
  const file = bucket.file(objectName);

  await file.save(buffer, {
    metadata: {
      contentType: mimetype,
      cacheControl: 'public, max-age=31536000',
    },
    predefinedAcl: 'publicRead',
  });

  const publicUrl = `https://storage.googleapis.com/${process.env.GCS_BUCKET_NAME}/${objectName}`;
  logger.info(`Image uploaded to GCS: ${objectName}`);
  return { publicUrl, objectName };
};

/**
 * Delete a single image from GCS.
 * Silently skips if GCS not configured.
 */
const deleteProductImage = async (objectName) => {
  if (!GCS_ENABLED || !bucket) return;
  try {
    await bucket.file(objectName).delete();
    logger.info(`Image deleted from GCS: ${objectName}`);
  } catch (err) {
    logger.warn(`Could not delete GCS object: ${objectName}`, { error: err.message });
  }
};

/**
 * Delete all images for a product from GCS.
 * Silently skips if GCS not configured.
 */
const deleteAllProductImages = async (productId) => {
  if (!GCS_ENABLED || !bucket) return;
  try {
    const prefix = `products/${productId}/`;
    const [files] = await bucket.getFiles({ prefix });
    await Promise.all(files.map((f) => f.delete()));
    logger.info(`Deleted all images for product ${productId}`);
  } catch (err) {
    logger.warn(`Error deleting images for product ${productId}:`, { error: err.message });
  }
};

module.exports = {
  validateImage,
  uploadProductImage,
  deleteProductImage,
  deleteAllProductImages,
};
