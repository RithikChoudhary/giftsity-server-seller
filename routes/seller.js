const express = require('express');
const multer = require('multer');
const Product = require('../../server/models/Product');
const Order = require('../../server/models/Order');
const Seller = require('../../server/models/Seller');
const SellerPayout = require('../../server/models/SellerPayout');
const PlatformSettings = require('../../server/models/PlatformSettings');
const Shipment = require('../../server/models/Shipment');
const { requireAuth, requireSeller } = require('../../server/middleware/auth');
const { uploadImage, uploadVideo, deleteImage, deleteVideo, deleteMedia } = require('../../server/config/cloudinary');
const { slugify } = require('../../server/utils/slugify');
const { getCommissionRate } = require('../../server/utils/commission');
const shiprocket = require('../../server/config/shiprocket');
const { sanitizeBody } = require('../../server/middleware/sanitize');
const { logActivity } = require('../../server/utils/audit');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } }); // 100MB for video support

router.use(requireAuth, requireSeller);

// =================== DASHBOARD ===================
router.get('/dashboard', async (req, res) => {
  try {
    const sellerId = req.user._id;
    const settings = await PlatformSettings.getSettings();
    const commissionRate = getCommissionRate(req.user, settings);

    const totalOrders = await Order.countDocuments({ sellerId, paymentStatus: 'paid' });
    const totalSalesAgg = await Order.aggregate([
      { $match: { sellerId: req.user._id, paymentStatus: 'paid' } },
      { $group: { _id: null, total: { $sum: '$totalAmount' }, commission: { $sum: '$commissionAmount' }, sellerEarnings: { $sum: '$sellerAmount' } } }
    ]);

    const stats = totalSalesAgg[0] || { total: 0, commission: 0, sellerEarnings: 0 };
    const pendingOrders = await Order.countDocuments({ sellerId, status: { $in: ['pending', 'confirmed', 'processing'] } });
    const totalProducts = await Product.countDocuments({ sellerId });
    const activeProducts = await Product.countDocuments({ sellerId, isActive: true });

    const pendingPayoutAgg = await Order.aggregate([
      { $match: { sellerId: req.user._id, paymentStatus: 'paid', status: 'delivered', payoutStatus: 'pending' } },
      { $group: { _id: null, total: { $sum: '$sellerAmount' }, count: { $sum: 1 } } }
    ]);
    const pendingPayout = pendingPayoutAgg[0] || { total: 0, count: 0 };

    const recentOrders = await Order.find({ sellerId }).sort({ createdAt: -1 }).limit(10).select('orderNumber status totalAmount sellerAmount createdAt items');

    // Get fresh user data for metrics
    const freshUser = await Seller.findById(sellerId);
    const metrics = freshUser?.sellerProfile?.metrics || {};

    res.json({
      stats: {
        totalSales: stats.total,
        totalOrders,
        totalCommissionPaid: stats.commission,
        totalEarnings: stats.sellerEarnings,
        pendingOrders,
        totalProducts,
        activeProducts
      },
      currentPeriodEarnings: {
        pendingAmount: pendingPayout.total,
        pendingOrderCount: pendingPayout.count
      },
      yourCommissionRate: commissionRate,
      healthMetrics: {
        healthScore: metrics.healthScore ?? null,
        fulfillmentRate: metrics.fulfillmentRate ?? null,
        cancelRate: metrics.cancelRate ?? null,
        lateShipmentRate: metrics.lateShipmentRate ?? null,
        avgShipTimeHours: metrics.avgShipTimeHours ?? null,
        warningCount: metrics.warningCount ?? 0,
        lastCalculatedAt: metrics.lastCalculatedAt || null
      },
      recentOrders
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// =================== PRODUCTS CRUD ===================
router.get('/products', async (req, res) => {
  try {
    const products = await Product.find({ sellerId: req.user._id }).sort({ createdAt: -1 });
    res.json({ products });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/products', upload.array('media', 15), sanitizeBody, async (req, res) => {
  const allUploadedPublicIds = []; // Track for cleanup on failure
  try {
    const sellerId = req.user._id;
    const data = { ...req.body, sellerId };
    data.slug = slugify(data.title);

    const sellerFolder = `giftsity/products/${sellerId}`;
    const uploadedImages = [];
    const uploadedMedia = [];

    // Handle uploaded files (images + videos via multipart)
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const base64 = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
        const isVideo = file.mimetype.startsWith('video/');

        if (isVideo) {
          const result = await uploadVideo(base64, { folder: `${sellerFolder}/videos` });
          allUploadedPublicIds.push({ publicId: result.publicId, type: 'video' });
          uploadedMedia.push({ type: 'video', url: result.url, thumbnailUrl: result.thumbnailUrl, publicId: result.publicId, duration: result.duration, width: result.width, height: result.height });
        } else {
          const result = await uploadImage(base64, { folder: sellerFolder });
          allUploadedPublicIds.push({ publicId: result.publicId, type: 'image' });
          uploadedImages.push(result);
          uploadedMedia.push({ type: 'image', url: result.url, publicId: result.publicId, width: result.width || 0, height: result.height || 0 });
        }
      }
    }

    // Also handle base64 strings sent in body (backward compat)
    if (data.newImages && Array.isArray(data.newImages)) {
      for (const img of data.newImages) {
        if (typeof img === 'string' && img.startsWith('data:')) {
          const result = await uploadImage(img, { folder: sellerFolder });
          allUploadedPublicIds.push({ publicId: result.publicId, type: 'image' });
          uploadedImages.push(result);
          uploadedMedia.push({ type: 'image', url: result.url, publicId: result.publicId });
        }
      }
      delete data.newImages;
    }

    // Handle base64 video strings in body
    if (data.newVideos && Array.isArray(data.newVideos)) {
      for (const vid of data.newVideos) {
        if (typeof vid === 'string' && vid.startsWith('data:')) {
          const result = await uploadVideo(vid, { folder: `${sellerFolder}/videos` });
          allUploadedPublicIds.push({ publicId: result.publicId, type: 'video' });
          uploadedMedia.push({ type: 'video', url: result.url, thumbnailUrl: result.thumbnailUrl, publicId: result.publicId, duration: result.duration, width: result.width, height: result.height });
        }
      }
      delete data.newVideos;
    }

    if (uploadedImages.length > 0) data.images = uploadedImages;
    if (uploadedMedia.length > 0) data.media = uploadedMedia;

    // Parse numeric fields from FormData strings
    if (data.price) data.price = Number(data.price);
    if (data.stock) data.stock = Number(data.stock);
    if (data.weight) data.weight = Number(data.weight);

    // Parse customization fields from FormData
    data.isCustomizable = data.isCustomizable === 'true' || data.isCustomizable === true;
    if (data.customizationOptions && typeof data.customizationOptions === 'string') {
      try { data.customizationOptions = JSON.parse(data.customizationOptions); } catch (e) { data.customizationOptions = []; }
    }
    if (!data.isCustomizable) data.customizationOptions = [];

    const product = new Product(data);
    await product.save();
    logActivity({ domain: 'seller', action: 'product_created', actorRole: 'seller', actorId: req.user._id, actorEmail: req.user.email, targetType: 'Product', targetId: product._id, message: `Product "${product.title}" created` });
    res.status(201).json({ product, message: 'Product created' });
  } catch (err) {
    // Cleanup orphaned uploads if product save failed
    for (const item of allUploadedPublicIds) {
      await deleteMedia(item.publicId, item.type).catch(() => {});
    }
    console.error('Create product error:', err.message);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.put('/products/:id', upload.array('media', 15), sanitizeBody, async (req, res) => {
  const newUploadedPublicIds = []; // Track new uploads for cleanup on failure
  try {
    const sellerId = req.user._id;
    const product = await Product.findOne({ _id: req.params.id, sellerId });
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const data = { ...req.body, updatedAt: Date.now() };
    const sellerFolder = `giftsity/products/${sellerId}`;

    // Parse existing images from JSON string (sent via FormData)
    let existingImages = [];
    if (data.existingImages) {
      try { existingImages = JSON.parse(data.existingImages); } catch { existingImages = []; }
      delete data.existingImages;
    }

    // Parse existing media from JSON string
    let existingMedia = [];
    if (data.existingMedia) {
      try { existingMedia = JSON.parse(data.existingMedia); } catch { existingMedia = []; }
      delete data.existingMedia;
    }

    // Handle uploaded files (images + videos via multipart)
    const uploadedImages = [];
    const uploadedMedia = [];
    if (req.files && req.files.length > 0) {
      for (const file of req.files) {
        const base64 = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
        const isVideo = file.mimetype.startsWith('video/');

        if (isVideo) {
          const result = await uploadVideo(base64, { folder: `${sellerFolder}/videos` });
          newUploadedPublicIds.push({ publicId: result.publicId, type: 'video' });
          uploadedMedia.push({ type: 'video', url: result.url, thumbnailUrl: result.thumbnailUrl, publicId: result.publicId, duration: result.duration, width: result.width, height: result.height });
        } else {
          const result = await uploadImage(base64, { folder: sellerFolder });
          newUploadedPublicIds.push({ publicId: result.publicId, type: 'image' });
          uploadedImages.push(result);
          uploadedMedia.push({ type: 'image', url: result.url, publicId: result.publicId });
        }
      }
    }

    // Also handle base64 image strings in body (backward compat)
    if (data.newImages && Array.isArray(data.newImages)) {
      for (const img of data.newImages) {
        if (typeof img === 'string' && img.startsWith('data:')) {
          const result = await uploadImage(img, { folder: sellerFolder });
          newUploadedPublicIds.push({ publicId: result.publicId, type: 'image' });
          uploadedImages.push(result);
          uploadedMedia.push({ type: 'image', url: result.url, publicId: result.publicId });
        }
      }
      delete data.newImages;
    }

    // Handle base64 video strings in body
    if (data.newVideos && Array.isArray(data.newVideos)) {
      for (const vid of data.newVideos) {
        if (typeof vid === 'string' && vid.startsWith('data:')) {
          const result = await uploadVideo(vid, { folder: `${sellerFolder}/videos` });
          newUploadedPublicIds.push({ publicId: result.publicId, type: 'video' });
          uploadedMedia.push({ type: 'video', url: result.url, thumbnailUrl: result.thumbnailUrl, publicId: result.publicId, duration: result.duration, width: result.width, height: result.height });
        }
      }
      delete data.newVideos;
    }

    // Merge existing + newly uploaded
    if (uploadedImages.length > 0 || existingImages.length > 0) {
      data.images = [...existingImages, ...uploadedImages];
    }
    if (uploadedMedia.length > 0 || existingMedia.length > 0) {
      data.media = [...existingMedia, ...uploadedMedia];
    }

    // Handle deleted images (cleanup from Cloudinary)
    if (data.deletedImageIds) {
      let ids = data.deletedImageIds;
      if (typeof ids === 'string') { try { ids = JSON.parse(ids); } catch { ids = []; } }
      if (Array.isArray(ids)) {
        for (const publicId of ids) { await deleteImage(publicId); }
      }
      delete data.deletedImageIds;
    }

    // Handle deleted media (images + videos cleanup from Cloudinary)
    if (data.deletedMediaIds) {
      let mediaIds = data.deletedMediaIds;
      if (typeof mediaIds === 'string') { try { mediaIds = JSON.parse(mediaIds); } catch { mediaIds = []; } }
      if (Array.isArray(mediaIds)) {
        for (const item of mediaIds) {
          if (typeof item === 'object' && item.publicId) {
            await deleteMedia(item.publicId, item.type || 'image');
          } else if (typeof item === 'string') {
            // Look up type from product's existing media to delete correctly
            const mediaEntry = product.media?.find(m => m.publicId === item);
            await deleteMedia(item, mediaEntry?.type || 'image');
          }
        }
      }
      delete data.deletedMediaIds;
    }

    // Parse numeric fields from FormData strings
    if (data.price) data.price = Number(data.price);
    if (data.stock) data.stock = Number(data.stock);
    if (data.weight) data.weight = Number(data.weight);

    // Parse customization fields from FormData
    if (data.isCustomizable !== undefined) {
      data.isCustomizable = data.isCustomizable === 'true' || data.isCustomizable === true;
    }
    if (data.customizationOptions && typeof data.customizationOptions === 'string') {
      try { data.customizationOptions = JSON.parse(data.customizationOptions); } catch (e) { data.customizationOptions = []; }
    }
    if (data.isCustomizable === false) data.customizationOptions = [];

    Object.assign(product, data);
    await product.save();
    logActivity({ domain: 'seller', action: 'product_updated', actorRole: 'seller', actorId: req.user._id, actorEmail: req.user.email, targetType: 'Product', targetId: product._id, message: `Product "${product.title}" updated` });
    res.json({ product, message: 'Product updated' });
  } catch (err) {
    // Cleanup newly uploaded files if save failed
    for (const item of newUploadedPublicIds) {
      await deleteMedia(item.publicId, item.type).catch(() => {});
    }
    console.error('Update product error:', err.message);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.delete('/products/:id', async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, sellerId: req.user._id });
    if (!product) return res.status(404).json({ message: 'Product not found' });

    // Clean up all Cloudinary assets (deduplicated to avoid double-deletion)
    const deletedIds = new Set();
    for (const img of product.images || []) {
      if (img.publicId && !deletedIds.has(img.publicId)) {
        deletedIds.add(img.publicId);
        await deleteImage(img.publicId);
      }
    }
    for (const m of product.media || []) {
      if (m.publicId && !deletedIds.has(m.publicId)) {
        deletedIds.add(m.publicId);
        await deleteMedia(m.publicId, m.type || 'image');
      }
    }

    await Product.findByIdAndDelete(req.params.id);
    logActivity({ domain: 'seller', action: 'product_deleted', actorRole: 'seller', actorId: req.user._id, actorEmail: req.user.email, targetType: 'Product', targetId: req.params.id, message: `Product deleted` });
    res.json({ message: 'Product deleted' });
  } catch (err) {
    console.error('Delete product error:', err.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// =================== BULK CSV UPLOAD ===================
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB max CSV

router.post('/products/bulk-csv', csvUpload.single('csv'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No CSV file provided' });

    const content = req.file.buffer.toString('utf-8');
    const lines = content.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return res.status(400).json({ message: 'CSV must have a header row and at least one data row' });

    // Parse header
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const requiredCols = ['title', 'price', 'stock', 'category'];
    for (const col of requiredCols) {
      if (!headers.includes(col)) {
        return res.status(400).json({ message: `Missing required column: ${col}. Required: ${requiredCols.join(', ')}` });
      }
    }

    const results = { success: 0, failed: 0, errors: [] };
    const Category = require('../../server/models/Category');
    const categories = await Category.find().lean();
    const catMap = {};
    for (const c of categories) {
      catMap[c.name.toLowerCase()] = c._id;
      catMap[c.slug?.toLowerCase()] = c._id;
    }

    for (let i = 1; i < lines.length; i++) {
      try {
        // Simple CSV parse (handles quoted fields with commas)
        const vals = [];
        let current = '';
        let inQuotes = false;
        for (const ch of lines[i]) {
          if (ch === '"') { inQuotes = !inQuotes; }
          else if (ch === ',' && !inQuotes) { vals.push(current.trim()); current = ''; }
          else { current += ch; }
        }
        vals.push(current.trim());

        const row = {};
        headers.forEach((h, idx) => { row[h] = vals[idx] || ''; });

        // Validate
        if (!row.title) { results.errors.push({ row: i + 1, error: 'Title is required' }); results.failed++; continue; }
        const price = parseFloat(row.price);
        if (isNaN(price) || price <= 0) { results.errors.push({ row: i + 1, error: 'Invalid price' }); results.failed++; continue; }
        const stock = parseInt(row.stock);
        if (isNaN(stock) || stock < 0) { results.errors.push({ row: i + 1, error: 'Invalid stock' }); results.failed++; continue; }

        const categoryId = catMap[row.category.toLowerCase()];
        if (!categoryId) { results.errors.push({ row: i + 1, error: `Category "${row.category}" not found` }); results.failed++; continue; }

        const slug = slugify(row.title);
        const product = new Product({
          title: row.title,
          description: row.description || '',
          price,
          compareAtPrice: row.compareatprice ? parseFloat(row.compareatprice) : undefined,
          stock,
          category: categoryId,
          sellerId: req.user._id,
          slug,
          sku: row.sku || '',
          tags: row.tags ? row.tags.split(';').map(t => t.trim()).filter(Boolean) : [],
          images: [],
          media: [],
          isActive: true
        });
        await product.save();
        results.success++;
      } catch (rowErr) {
        results.errors.push({ row: i + 1, error: rowErr.message });
        results.failed++;
      }
    }

    logActivity({ domain: 'seller', action: 'bulk_csv_upload', actorRole: 'seller', actorId: req.user._id, actorEmail: req.user.email, message: `Bulk CSV: ${results.success} created, ${results.failed} failed` });
    res.json({ message: `Import complete: ${results.success} products created, ${results.failed} failed`, ...results });
  } catch (err) {
    console.error('Bulk CSV error:', err.message);
    res.status(500).json({ message: 'Failed to process CSV' });
  }
});

// =================== ORDERS ===================
router.get('/orders', async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = { sellerId: req.user._id };
    if (status) filter.status = status;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const orders = await Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).populate('customerId', 'name email phone');
    const total = await Order.countDocuments(filter);

    res.json({ orders, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/orders/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const order = await Order.findOne({ _id: req.params.id, sellerId: req.user._id });
    if (!order) return res.status(404).json({ message: 'Order not found' });

    const transitions = { pending: ['confirmed', 'cancelled'], confirmed: ['shipped', 'cancelled'], shipped: ['delivered'], processing: ['shipped', 'cancelled'] };
    const allowed = transitions[order.status] || [];
    if (!allowed.includes(status)) return res.status(400).json({ message: `Cannot change from ${order.status} to ${status}` });

    order.status = status;
    if (status === 'cancelled') order.cancelledAt = new Date();
    if (status === 'delivered') {
      order.deliveredAt = new Date();
      // Send delivered email
      try {
        const { sendDeliveredEmail } = require('../../server/utils/email');
        if (order.customerEmail) await sendDeliveredEmail(order.customerEmail, order);
      } catch (e) { console.error('Delivered email error:', e.message); }
    }
    await order.save();

    // Send corporate order status email for B2B orders
    if (order.orderType === 'b2b_direct' && ['shipped', 'delivered', 'cancelled'].includes(status)) {
      try {
        const { sendCorporateOrderStatusEmail } = require('../../server/utils/email');
        if (order.customerEmail) await sendCorporateOrderStatusEmail(order.customerEmail, order, status);
      } catch (e) { console.error('Corporate status email error:', e.message); }
    }

    logActivity({ domain: 'seller', action: `order_${status}`, actorRole: 'seller', actorId: req.user._id, actorEmail: req.user.email, targetType: 'Order', targetId: order._id, message: `Order ${order.orderNumber} marked as ${status}` });
    res.json({ order, message: `Order ${status}` });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/orders/:id/ship', async (req, res) => {
  try {
    const { courierName, trackingNumber, estimatedDelivery } = req.body;
    const order = await Order.findOne({ _id: req.params.id, sellerId: req.user._id });
    if (!order) return res.status(404).json({ message: 'Order not found' });

    order.status = 'shipped';
    order.trackingInfo = {
      courierName: courierName || '',
      trackingNumber: trackingNumber || '',
      shippedAt: new Date(),
      estimatedDelivery: estimatedDelivery ? new Date(estimatedDelivery) : null
    };
    await order.save();

    // Send shipped email
    try {
      const { sendShippedEmail } = require('../../server/utils/email');
      if (order.customerEmail) await sendShippedEmail(order.customerEmail, order);
    } catch (e) { console.error('Shipped email error:', e.message); }

    // Send corporate order status email for B2B orders
    if (order.orderType === 'b2b_direct') {
      try {
        const { sendCorporateOrderStatusEmail } = require('../../server/utils/email');
        if (order.customerEmail) await sendCorporateOrderStatusEmail(order.customerEmail, order, 'shipped');
      } catch (e) { console.error('Corporate shipped email error:', e.message); }
    }

    logActivity({ domain: 'seller', action: 'order_shipped', actorRole: 'seller', actorId: req.user._id, actorEmail: req.user.email, targetType: 'Order', targetId: order._id, message: `Order ${order.orderNumber} shipped via ${courierName || 'unknown'}`, metadata: { courierName, trackingNumber } });
    res.json({ order, message: 'Order marked as shipped' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// =================== PAYOUTS ===================
router.get('/payouts', async (req, res) => {
  try {
    const payouts = await SellerPayout.find({ sellerId: req.user._id }).sort({ createdAt: -1 });
    res.json({ payouts });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// =================== SETTINGS ===================
router.get('/settings', async (req, res) => {
  try {
    const user = await Seller.findById(req.user._id);
    res.json({
      sellerProfile: user.sellerProfile,
      name: user.name,
      phone: user.phone,
      email: user.email
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/settings', sanitizeBody, async (req, res) => {
  try {
    const { businessName, businessAddress, pickupAddress, bankDetails, phone, bio, businessType, gstNumber, instagramUsername } = req.body;
    const user = req.user;

    if (businessName) user.sellerProfile.businessName = businessName;
    if (businessAddress) user.sellerProfile.businessAddress = businessAddress;
    if (pickupAddress) user.sellerProfile.pickupAddress = pickupAddress;
    if (bankDetails) user.sellerProfile.bankDetails = bankDetails;
    if (bio !== undefined) user.sellerProfile.bio = bio;
    if (phone) user.phone = phone;
    if (businessType !== undefined) user.sellerProfile.businessType = businessType;
    if (gstNumber !== undefined) user.sellerProfile.gstNumber = gstNumber;
    if (instagramUsername !== undefined) user.sellerProfile.instagramUsername = instagramUsername.replace('@', '').trim();

    await user.save();
    res.json({ message: 'Settings updated' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// POST /api/seller/upload-image - upload avatar or cover image
router.post('/upload-image', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });

    const { type } = req.body; // 'avatar' or 'cover'
    if (!type || !['avatar', 'cover'].includes(type)) {
      return res.status(400).json({ message: 'Type must be "avatar" or "cover"' });
    }

    const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowedMimes.includes(req.file.mimetype)) {
      return res.status(400).json({ message: 'Only JPEG, PNG, WebP, and GIF images are allowed' });
    }

    const seller = await Seller.findById(req.user._id);
    if (!seller) return res.status(404).json({ message: 'Seller not found' });

    const folder = `giftsity/sellers/${seller._id}/${type}`;
    const transformation = type === 'avatar'
      ? [{ width: 400, height: 400, crop: 'fill', gravity: 'face' }]
      : [{ width: 1200, height: 400, crop: 'limit', quality: 'auto:good' }];

    // Delete old image if exists
    const oldField = type === 'avatar' ? seller.sellerProfile.avatar : seller.sellerProfile.coverImage;
    if (oldField?.publicId) {
      try { await deleteImage(oldField.publicId); } catch {}
    }

    // Upload new image
    const result = await new Promise((resolve, reject) => {
      const { cloudinary: cld } = require('../../server/config/cloudinary');
      const stream = cld.uploader.upload_stream(
        { folder, transformation },
        (err, result) => err ? reject(err) : resolve(result)
      );
      stream.end(req.file.buffer);
    });

    // Update seller profile
    if (type === 'avatar') {
      seller.sellerProfile.avatar = { url: result.secure_url, publicId: result.public_id };
    } else {
      seller.sellerProfile.coverImage = { url: result.secure_url, publicId: result.public_id };
    }
    await seller.save();

    res.json({ url: result.secure_url, publicId: result.public_id });
  } catch (err) {
    console.error('Seller upload image error:', err);
    res.status(500).json({ message: 'Upload failed' });
  }
});

// =================== MARKETING ===================
router.get('/marketing', async (req, res) => {
  try {
    const user = req.user;
    res.json({
      referralCode: user.sellerProfile.referralCode,
      referralCount: user.sellerProfile.referralCount || 0,
      referralLink: `${process.env.CLIENT_URL}/seller/join?ref=${user.sellerProfile.referralCode}`,
      rewards: {
        featured: user.sellerProfile.referralCount >= 3,
        credit: user.sellerProfile.referralCount >= 5,
        lockedRate: user.sellerProfile.referralCount >= 10
      }
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// =================== SHIPPING (Shiprocket) ===================
router.post('/shipping/serviceability', async (req, res) => {
  try {
    const { orderId } = req.body;
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (order.sellerId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not your order' });
    }

    const seller = await Seller.findById(req.user._id);
    const pickupPincode = seller.sellerProfile?.pickupAddress?.pincode || seller.sellerProfile?.businessAddress?.pincode;
    if (!pickupPincode) return res.status(400).json({ message: 'Set your pickup address pincode in Seller Settings first' });

    const deliveryPincode = order.shippingAddress?.pincode;
    if (!deliveryPincode) return res.status(400).json({ message: 'Order has no delivery pincode' });

    const result = await shiprocket.checkServiceability({ pickupPincode, deliveryPincode, weight: 500, cod: 0 });

    const companies = result?.data?.available_courier_companies || result?.available_courier_companies || [];
    const couriers = companies.map(c => ({
      courierId: c.courier_company_id,
      courierName: c.courier_name,
      rate: c.rate,
      estimatedDays: c.estimated_delivery_days,
      etd: c.etd,
      rating: c.rating
    }));

    console.log('[Shipping] Returning', couriers.length, 'couriers');
    res.json({ couriers, pickupPincode, deliveryPincode });
  } catch (err) {
    console.error('Serviceability error:', err?.response?.data || err.message);
    res.status(500).json({ message: 'Failed to check serviceability', error: err?.response?.data?.message || err.message });
  }
});

router.post('/shipping/:orderId/create', async (req, res) => {
  try {
    const order = await Order.findById(req.params.orderId).populate('customerId', 'name email phone');
    if (!order) return res.status(404).json({ message: 'Order not found' });
    if (order.sellerId.toString() !== req.user._id.toString()) return res.status(403).json({ message: 'Not your order' });
    if (order.paymentStatus !== 'paid') return res.status(400).json({ message: 'Order not paid' });

    const existing = await Shipment.findOne({ orderId: order._id });
    if (existing && existing.shiprocketOrderId) return res.status(400).json({ message: 'Shipment already created', shipment: existing });

    const seller = await Seller.findById(req.user._id);
    const { weight = 500, length = 10, width = 10, height = 10 } = req.body;

    // Fetch registered pickup locations from Shiprocket and use the first active one
    let pickupLocationName = 'Primary';
    try {
      const pickupLocations = await shiprocket.getPickupLocations();
      const active = pickupLocations.find(loc => loc.status === 2) || pickupLocations[0];
      if (active?.pickup_location) {
        pickupLocationName = active.pickup_location;
      }
      console.log(`[Shiprocket] Using pickup location: "${pickupLocationName}"`);
    } catch (pickupErr) {
      console.warn('[Shiprocket] Could not fetch pickup locations, using default:', pickupErr.message);
    }

    const shiprocketData = {
      order_id: order.orderNumber,
      order_date: new Date().toISOString().split('T')[0],
      pickup_location: pickupLocationName,
      billing_customer_name: order.shippingAddress.name || 'Customer',
      billing_last_name: '',
      billing_address: order.shippingAddress.street,
      billing_city: order.shippingAddress.city,
      billing_pincode: order.shippingAddress.pincode,
      billing_state: order.shippingAddress.state,
      billing_country: 'India',
      billing_email: order.customerEmail,
      billing_phone: order.shippingAddress.phone || order.customerPhone,
      shipping_is_billing: true,
      order_items: order.items.map(item => ({
        name: item.title,
        sku: item.sku || `SKU-${item.productId}`,
        units: item.quantity,
        selling_price: item.price,
        discount: 0, tax: 0, hsn: ''
      })),
      payment_method: 'Prepaid',
      sub_total: order.totalAmount,
      length, breadth: width, height,
      weight: weight / 1000
    };

    const result = await shiprocket.createShiprocketOrder(shiprocketData);
    console.log('[Shiprocket] Create order response:', JSON.stringify(result, null, 2));

    // Extract IDs from multiple possible response formats
    const srOrderId = (result.order_id || result.payload?.order_id || '').toString();
    const srShipmentId = (result.shipment_id || result.payload?.shipment_id || '').toString();

    if (!srOrderId) {
      console.error('[Shiprocket] No order_id in response:', result);
      return res.status(500).json({ message: 'Shiprocket did not return an order ID', shiprocketResponse: result });
    }

    const shipment = existing || new Shipment({ orderId: order._id, sellerId: req.user._id });
    shipment.shiprocketOrderId = srOrderId;
    shipment.shiprocketShipmentId = srShipmentId;
    shipment.weight = weight;
    shipment.dimensions = { length, width, height };
    shipment.status = 'created';
    shipment.statusHistory.push({ status: 'created', description: 'Shipment created on Shiprocket' });
    await shipment.save();

    if (!srShipmentId) {
      console.warn('[Shiprocket] Shipment created but no shipment_id returned. Courier assignment will need shipment_id.');
    }

    order.status = 'processing';
    await order.save();

    res.json({ message: 'Shipment created', shipment, warning: !srShipmentId ? 'No shipment_id returned — courier assignment may fail until Shiprocket processes this order' : undefined });
  } catch (err) {
    console.error('Create shipment error:', err?.response?.data || err.message);
    res.status(500).json({ message: 'Failed to create shipment', error: err?.response?.data?.message || err.message });
  }
});

router.post('/shipping/:orderId/assign-courier', async (req, res) => {
  try {
    const { courierId } = req.body;
    const shipment = await Shipment.findOne({ orderId: req.params.orderId, sellerId: req.user._id });
    if (!shipment) return res.status(404).json({ message: 'Shipment not found' });

    if (!shipment.shiprocketShipmentId) {
      return res.status(400).json({ message: 'Shipment ID missing — please recreate the shipment' });
    }

    const result = await shiprocket.assignCourier({ shipmentId: shipment.shiprocketShipmentId, courierId });

    shipment.awbCode = result.response?.data?.awb_code || result.awb_code || '';
    shipment.courierName = result.response?.data?.courier_name || result.courier_name || '';
    shipment.courierId = courierId;
    shipment.statusHistory.push({ status: 'courier_assigned', description: `Courier: ${shipment.courierName}` });
    await shipment.save();

    res.json({ message: 'Courier assigned', shipment });
  } catch (err) {
    console.error('Assign courier error:', err?.response?.data || err.message);
    res.status(500).json({ message: err?.response?.data?.message || 'Failed to assign courier', error: err?.response?.data });
  }
});

router.post('/shipping/:orderId/pickup', async (req, res) => {
  try {
    const shipment = await Shipment.findOne({ orderId: req.params.orderId, sellerId: req.user._id });
    if (!shipment) return res.status(404).json({ message: 'Shipment not found' });

    const result = await shiprocket.schedulePickup({ shipmentId: shipment.shiprocketShipmentId });

    shipment.status = 'pickup_scheduled';
    shipment.pickupScheduledAt = new Date();
    shipment.statusHistory.push({ status: 'pickup_scheduled', description: 'Pickup scheduled' });
    await shipment.save();

    const order = await Order.findById(req.params.orderId);
    if (order) {
      order.status = 'shipped';
      order.trackingInfo = { courierName: shipment.courierName, trackingNumber: shipment.awbCode, shippedAt: new Date() };
      await order.save();
    }

    res.json({ message: 'Pickup scheduled', shipment });
  } catch (err) {
    res.status(500).json({ message: 'Failed to schedule pickup' });
  }
});

router.get('/shipping/:orderId/track', async (req, res) => {
  try {
    const shipment = await Shipment.findOne({ orderId: req.params.orderId, sellerId: req.user._id });
    if (!shipment) return res.status(404).json({ message: 'No shipment' });

    if (shipment.awbCode) {
      try {
        const trackData = await shiprocket.trackByAwb(shipment.awbCode);
        return res.json({ shipment, tracking: trackData });
      } catch { /* fall through */ }
    }
    res.json({ shipment, tracking: null });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.get('/shipping/:orderId/label', async (req, res) => {
  try {
    const shipment = await Shipment.findOne({ orderId: req.params.orderId, sellerId: req.user._id });
    if (!shipment) return res.status(404).json({ message: 'No shipment' });

    const result = await shiprocket.generateLabel({ shipmentId: shipment.shiprocketShipmentId });
    shipment.labelUrl = result.label_url || '';
    await shipment.save();
    res.json({ labelUrl: shipment.labelUrl });
  } catch (err) {
    res.status(500).json({ message: 'Failed' });
  }
});

// =================== SUSPENSION REMOVAL ===================
router.post('/request-unsuspend', async (req, res) => {
  try {
    const user = req.user;
    if (user.status !== 'suspended') return res.status(400).json({ message: 'Account not suspended' });
    const { reason } = req.body;
    if (!reason || reason.trim().length < 10) return res.status(400).json({ message: 'Provide a detailed reason (min 10 characters)' });

    user.sellerProfile.suspensionRemovalRequested = true;
    user.sellerProfile.suspensionRemovalReason = reason.trim();
    await user.save();

    logActivity({ domain: 'seller', action: 'unsuspend_requested', actorRole: 'seller', actorId: req.user._id, actorEmail: req.user.email, targetType: 'Seller', targetId: user._id, message: `Seller requested unsuspension: ${reason.trim().substring(0, 100)}` });
    res.json({ message: 'Suspension removal request submitted. Admin will review.' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
