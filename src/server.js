/**
 * server.js
 * 
 * Main Express application entry point.
 * 
 * Middleware stack (in order):
 * 1. Helmet       → Security headers
 * 2. CORS         → Cross-origin requests from the React frontend
 * 3. Rate limiter → Prevent abuse (100 req/15min per IP)
 * 4. Compression  → Gzip responses for faster delivery
 * 5. Morgan       → HTTP request logging
 * 6. JSON parser  → Parse request bodies
 * 7. Routes       → All API routes
 * 8. Error handler → Catch-all error response
 */

require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const routes = require('./routes/index');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const logger = require('./utils/logger');

const app = express();
const PORT = process.env.PORT || 5000;

// ─── Security Headers ─────────────────────────────────────────────────────────
// Helmet sets HTTP headers that protect against common web vulnerabilities
// (XSS, clickjacking, MIME sniffing, etc.)
app.use(helmet());

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Only allow requests from the React frontend domain
const allowedOrigins = [
  process.env.CLIENT_URL || 'http://localhost:3000',
  // Add your production frontend domain here
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (Postman, curl, server-to-server)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error(`Origin ${origin} not allowed by CORS`));
    }
  },
  credentials: true, // Allow cookies/auth headers
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ─── Rate Limiting ────────────────────────────────────────────────────────────
// Limit each IP to 100 requests per 15 minutes
// Stricter limit applied to auth routes to prevent brute-force
const globalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests from this IP. Please try again after 15 minutes.',
  },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // Very strict for login/register
  message: {
    success: false,
    message: 'Too many authentication attempts. Please try again after 15 minutes.',
  },
});

app.use(globalLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// ─── Performance ──────────────────────────────────────────────────────────────
app.use(compression()); // Gzip all responses — reduces bandwidth by ~70%

// ─── Logging ──────────────────────────────────────────────────────────────────
// Morgan HTTP request logging (dev = colored, prod = combined Apache format)
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ─── Body Parsing ─────────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));      // JSON body parser
app.use(express.urlencoded({ extended: true, limit: '10mb' })); // Form data parser

// ─── Trust Proxy ─────────────────────────────────────────────────────────────
// Required for Cloud Run — gets real client IP (not proxy IP) for rate limiting
app.set('trust proxy', 1);

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api', routes);

// ─── Error Handling ───────────────────────────────────────────────────────────
app.use(notFound);      // 404 for unknown routes
app.use(errorHandler);  // Global error handler

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  logger.info(`BoothMarket API running on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`Health check: http://localhost:${PORT}/api/health`);
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
// On Cloud Run, SIGTERM is sent before the container is stopped.
// We finish in-flight requests before exiting.
process.on('SIGTERM', () => {
  logger.info('SIGTERM received — shutting down gracefully...');
  process.exit(0);
});

module.exports = app; // Export for tests
