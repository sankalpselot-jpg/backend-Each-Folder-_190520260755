/**
 * middleware/upload.js
 * 
 * Multer configuration for handling multipart/form-data (image uploads).
 * Uses memory storage — files are held in RAM buffer temporarily,
 * then uploaded to GCS. No temp files written to disk.
 * 
 * Limits: 5MB per file, up to 8 images per request.
 */

const multer = require('multer');

const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB in bytes
const MAX_FILES = 8;

// ─── File Filter ──────────────────────────────────────────────────────────────
// Reject non-image files before they hit the memory buffer
const fileFilter = (req, file, cb) => {
  if (ALLOWED_MIME_TYPES.includes(file.mimetype)) {
    cb(null, true); // Accept file
  } else {
    cb(
      Object.assign(new Error('Only JPG, PNG, and WebP images are allowed.'), {
        statusCode: 400,
      }),
      false // Reject file
    );
  }
};

// ─── Multer Instance ──────────────────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(), // Keep in RAM buffer (not disk)
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: MAX_FILES,
  },
  fileFilter,
});

// ─── Exported Middleware Variants ─────────────────────────────────────────────

/**
 * For uploading multiple product images (field name: 'images').
 * Used in: POST /api/products, PUT /api/products/:id
 */
const uploadProductImages = upload.array('images', MAX_FILES);

/**
 * For uploading a single profile picture (field name: 'profile_image').
 */
const uploadProfileImage = upload.single('profile_image');

/**
 * Wraps multer in a promise so async/await works in controllers.
 * Converts multer's callback-style to promise-style.
 */
const handleUpload = (middleware) => (req, res) =>
  new Promise((resolve, reject) => {
    middleware(req, res, (err) => {
      if (err) {
        err.statusCode = err.code === 'LIMIT_FILE_SIZE' ? 400 : err.statusCode || 400;
        err.message = err.code === 'LIMIT_FILE_SIZE'
          ? `File too large. Maximum size is 5MB.`
          : err.message;
        reject(err);
      } else {
        resolve();
      }
    });
  });

module.exports = { uploadProductImages, uploadProfileImage, handleUpload };
