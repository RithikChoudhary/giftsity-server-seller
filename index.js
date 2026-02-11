require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('../server/config/db');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.SELLER_PORT || 5001;

// Middleware - CORS supports comma-separated origins in CLIENT_URL
const allowedOrigins = (process.env.CLIENT_URL || 'http://localhost:5173').split(',').map(s => s.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) cb(null, true);
    else cb(new Error('CORS not allowed'));
  },
  credentials: true
}));
app.use(express.json({ limit: '100mb' }));

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
  console.error('[Seller Server Error]', err.message);
  res.status(err.status || 500).json({ message: err.message || 'Internal server error' });
});

// Graceful error handling
process.on('unhandledRejection', (err) => {
  console.error('[Unhandled Rejection]', err);
});

// Start
connectDB().then(() => {
  app.listen(PORT, () => console.log(`Giftsity Seller server running on port ${PORT}`));
});
