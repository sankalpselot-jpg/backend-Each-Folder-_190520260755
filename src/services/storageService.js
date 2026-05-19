/**
 * services/storageService.js
 * 
 * Google Cloud Storage integration for product images.
 * - Uploads images to GCS with unique names
 * - Returns public CDN URLs
 * - Deletes images when products are removed
 * 
 * Images are stored at: gs://boothmarket-assets/products/{productId}/{uuid}.{ext}
 * Public URL: https://storage.googleapis.com/boothmarket-assets/products/...
 */

const { Storage } = require('@google-cloud/storage');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const logger = require('../utils/logger');

// Initialize GCS client
// In Cloud Run, credentials come from the service account attached to the instance.
// Locally, use GOOGLE_APPLICATION_CREDENTIALS env var pointing to a JSON key file.
const storage = new Storage({
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
});

const bucket = storage.bucket(process.env.GCS_BUCKET_NAME);

// ─── Allowed MIME Types ───────────────────────────────────────────────────────
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE_MB = 5;
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

/**
 * Validate that a file is a safe image type and within size limits.
 * Called before uploading to prevent storing malicious files.
 */
const validateImage = (file) => {
  if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    throw new Error(`Invalid file type. Allowed: JPG, PNG, WebP`);
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(`File too large. Maximum size: ${MAX_FILE_SIZE_MB}MB`);
  }
};

/**
 * Upload a single image buffer to Google Cloud Storage.
 * 
 * @param {Buffer} buffer      - File buffer from multer memory storage
 * @param {string} mimetype    - e.g. 'image/jpeg'
 * @param {string} productId   - Used to organize files in GCS folders
 * @returns {{ publicUrl, objectName }} - GCS public URL and object name
 */
const uploadProductImage = async (buffer, mimetype, productId) => {
  // Generate a unique filename to prevent collisions and enumeration attacks
  const ext = mimetype.split('/')[1].replace('jpeg', 'jpg');
  const objectName = `products/${productId}/${uuidv4()}.${ext}`;

  const file = bucket.file(objectName);

  // Upload the buffer to GCS
  await file.save(buffer, {
    metadata: {
      contentType: mimetype,
      cacheControl: 'public, max-age=31536000', // 1 year cache (images are immutable)
    },
    // Make the file publicly readable (no auth needed to view images)
    predefinedAcl: 'publicRead',
  });

  // Construct the public CDN URL
  const publicUrl = `https://storage.googleapis.com/${process.env.GCS_BUCKET_NAME}/${objectName}`;

  logger.info(`Image uploaded to GCS: ${objectName}`);
  return { publicUrl, objectName };
};

/**
 * Delete a single image from GCS by its object name.
 * Called when a product image is removed or the product is deleted.
 * 
 * @param {string} objectName - The GCS path, e.g. 'products/{id}/file.jpg'
 */
const deleteProductImage = async (objectName) => {
  try {
    await bucket.file(objectName).delete();
    logger.info(`Image deleted from GCS: ${objectName}`);
  } catch (err) {
    // Log but don't throw — a missing file in GCS shouldn't crash the API
    logger.warn(`Could not delete GCS object (may already be gone): ${objectName}`, {
      error: err.message,
    });
  }
};

/**
 * Delete all images associated with a product (used when deleting entire product).
 * 
 * @param {string} productId - Deletes everything under products/{productId}/
 */
const deleteAllProductImages = async (productId) => {
  try {
    const prefix = `products/${productId}/`;
    const [files] = await bucket.getFiles({ prefix });
    await Promise.all(files.map((f) => f.delete()));
    logger.info(`Deleted all images for product ${productId}`);
  } catch (err) {
    logger.warn(`Error deleting all images for product ${productId}:`, { error: err.message });
  }
};

module.exports = {
  validateImage,
  uploadProductImage,
  deleteProductImage,
  deleteAllProductImages,
};
