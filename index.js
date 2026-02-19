require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const mongoose = require('mongoose');
const connectDB = require('../server/config/db');
const logger = require('../server/utils/logger');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.SELLER_PORT || 5001;

// CORS must run before helmet so preflight OPTIONS requests get proper headers
const allowedOrigins = (process.env.CLIENT_URL || 'http://localhost:5173').split(',').map(s => s.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) cb(null, true);
    else cb(new Error('CORS not allowed'));
  },
  credentials: true
}));

// Security headers (API-friendly: disable CSP and embedder policy)
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false
}));

// Compression
app.use(compression());
app.use(express.json({ limit: '2mb' }));

// Request logging (skip health checks, demote fast requests to debug)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    if (req.originalUrl === '/api/seller/health') return;
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : duration > 500 ? 'info' : 'debug';
    logger[level](`${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`, {
      method: req.method, url: req.originalUrl, status: res.statusCode, duration
    });
  });
  next();
});

// Routes - all mounted under /api/seller
app.use('/api/seller', require('./routes/seller'));

// Health check
app.get('/api/seller/health', (req, res) => res.json({ status: 'ok', service: 'giftsity-seller', port: PORT }));

// 404 handler for undefined routes
app.use((req, res) => {
  res.status(404).json({ message: `Route ${req.method} ${req.originalUrl} not found` });
});

// Global error handler
app.use((err, req, res, _next) => {
  logger.error(`[Seller] ${req.method} ${req.originalUrl} - ${err.message}`, { stack: err.stack });
  res.status(err.status || 500).json({ message: err.message || 'Internal server error' });
});

// Graceful error handling
process.on('unhandledRejection', (err) => {
  logger.error('[Seller] Unhandled Rejection', { error: err?.message || err, stack: err?.stack });
});

// Start
connectDB().then(() => {
  const server = app.listen(PORT, () => {
    console.log(`[Startup] Giftsity Seller server running on port ${PORT}`);
    logger.info(`Giftsity Seller server running on port ${PORT}`);
  });

  // Graceful shutdown
  const shutdown = (signal) => {
    logger.info(`[Seller] ${signal} received, shutting down gracefully...`);
    server.close(() => {
      logger.info('[Seller] HTTP server closed');
      mongoose.connection.close(false).then(() => {
        logger.info('[Seller] MongoDB connection closed');
        process.exit(0);
      });
    });
    setTimeout(() => { process.exit(1); }, 10000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
});
