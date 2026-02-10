require('dotenv').config();
const express = require('express');
const cors = require('cors');
const connectDB = require('../server/config/db');

const app = express();
const PORT = process.env.SELLER_PORT || 5001;

// Middleware
app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173' }));
app.use(express.json({ limit: '10mb' }));

// Routes - all mounted under /api/seller
app.use('/api/seller', require('./routes/seller'));

// Health check
app.get('/api/seller/health', (req, res) => res.json({ status: 'ok', service: 'giftsity-seller', port: PORT }));

// Start
connectDB().then(() => {
  app.listen(PORT, () => console.log(`Giftsity Seller server running on port ${PORT}`));
});
