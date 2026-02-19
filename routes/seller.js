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
const { createRefund, getCashfreeOrder } = require('../../server/config/cashfree');
const { sanitizeBody } = require('../../server/middleware/sanitize');
const { logActivity } = require('../../server/utils/audit');
const { createNotification } = require('../../server/utils/notify');
const logger = require('../../server/utils/logger');
const { invalidateCache } = require('../../server/middleware/cache');
const { submitToIndexNow } = require('../../server/utils/indexnow');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 30 * 1024 * 1024 } }); // 30MB max per file

// Rate limiters for seller product endpoints
const productCreationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => req.user?._id?.toString() || 'unknown',
  message: { message: 'Too many product creation requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false
});
const csvUploadLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 3,
  keyGenerator: (req) => req.user?._id?.toString() || 'unknown',
  message: { message: 'Too many CSV uploads. Please wait a few minutes.' },
  standardHeaders: true,
  legacyHeaders: false
});

router.use(requireAuth, requireSeller);

// Allowed MIME types for seller product uploads
const ALLOWED_IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const ALLOWED_VIDEO_MIMES = ['video/mp4', 'video/webm', 'video/quicktime'];

// =================== PREFLIGHT (lightweight check) ===================
router.get('/preflight', async (req, res) => {
  try {
    const settings = await PlatformSettings.getSettings();
    const bank = req.user.sellerProfile?.bankDetails;
    const pickup = req.user.sellerProfile?.pickupAddress;
    res.json({
      minimumProductPrice: settings.minimumProductPrice || 200,
      bankDetailsComplete: !!(bank?.accountHolderName && bank?.accountNumber && bank?.ifscCode && bank?.bankName),
      pickupAddressComplete: !!(pickup?.street && pickup?.city && pickup?.pincode)
    });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// =================== DASHBOARD ===================
router.get('/dashboard', async (req, res) => {
  try {
    const sellerId = req.user._id;
    const settings = await PlatformSettings.getSettings();
    const commissionRate = getCommissionRate(req.user, settings);

    const SellerPayout = require('../../server/models/SellerPayout');

    // Run all independent queries in parallel
    const [totalOrders, totalSalesAgg, pendingOrders, totalProducts, activeProducts, pendingPayoutAgg, lifetimeAgg, recentOrders] = await Promise.all([
      Order.countDocuments({ sellerId, paymentStatus: 'paid' }),
      Order.aggregate([
        { $match: { sellerId: req.user._id, paymentStatus: 'paid' } },
        { $group: { _id: null, total: { $sum: '$totalAmount' }, commission: { $sum: '$commissionAmount' }, sellerEarnings: { $sum: '$sellerAmount' } } }
      ]),
      Order.countDocuments({ sellerId, status: { $in: ['pending', 'confirmed', 'processing'] } }),
      Product.countDocuments({ sellerId }),
      Product.countDocuments({ sellerId, isActive: true }),
      Order.aggregate([
        { $match: { sellerId: req.user._id, paymentStatus: 'paid', status: 'delivered', payoutStatus: 'pending' } },
        { $group: { _id: null, total: { $sum: '$sellerAmount' }, count: { $sum: 1 },
          totalSales: { $sum: { $ifNull: ['$itemTotal', '$totalAmount'] } },
          commissionDeducted: { $sum: { $ifNull: ['$commissionAmount', 0] } },
          gatewayFees: { $sum: { $ifNull: ['$paymentGatewayFee', 0] } },
          shippingDeducted: { $sum: { $cond: [{ $eq: ['$shippingPaidBy', 'seller'] }, { $ifNull: ['$actualShippingCost', { $ifNull: ['$shippingCost', 0] }] }, 0] } }
        }}
      ]),
      SellerPayout.aggregate([
        { $match: { sellerId: req.user._id, status: 'paid' } },
        { $group: { _id: null, total: { $sum: '$netPayout' } } }
      ]),
      Order.find({ sellerId }).sort({ createdAt: -1 }).limit(10).select('orderNumber status totalAmount sellerAmount createdAt items').lean()
    ]);

    const stats = totalSalesAgg[0] || { total: 0, commission: 0, sellerEarnings: 0 };
    const pendingPayout = pendingPayoutAgg[0] || { total: 0, count: 0, totalSales: 0, commissionDeducted: 0, gatewayFees: 0, shippingDeducted: 0 };
    const lifetimeEarnings = lifetimeAgg[0]?.total || 0;

    // Next payout date
    const schedule = settings.payoutSchedule || 'biweekly';
    const now = new Date();
    let nextPayoutDate;
    if (schedule === 'weekly') {
      nextPayoutDate = new Date(now);
      nextPayoutDate.setDate(now.getDate() + ((1 + 7 - now.getDay()) % 7 || 7));
    } else if (schedule === 'biweekly') {
      const day = now.getDate();
      if (day < 15) { nextPayoutDate = new Date(now.getFullYear(), now.getMonth(), 15); }
      else { nextPayoutDate = new Date(now.getFullYear(), now.getMonth() + 1, 1); }
    } else {
      nextPayoutDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    }
    const metrics = req.user.sellerProfile?.metrics || {};
    const bank = req.user.sellerProfile?.bankDetails;
    const bankDetailsComplete = !!(bank?.accountHolderName && bank?.accountNumber && bank?.ifscCode && bank?.bankName);
    const pickupAddr = req.user.sellerProfile?.pickupAddress;
    const pickupAddressComplete = !!(pickupAddr?.street && pickupAddr?.city && pickupAddr?.pincode);

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
        totalSales: pendingPayout.totalSales,
        commissionDeducted: pendingPayout.commissionDeducted,
        gatewayFees: pendingPayout.gatewayFees,
        shippingDeducted: pendingPayout.shippingDeducted,
        netEarning: Math.max(0, pendingPayout.total - pendingPayout.shippingDeducted),
        pendingAmount: Math.max(0, pendingPayout.total - pendingPayout.shippingDeducted),
        pendingOrderCount: pendingPayout.count
      },
      lifetimeEarnings,
      nextPayoutDate: nextPayoutDate.toISOString(),
      payoutSchedule: schedule,
      bankDetailsComplete,
      pickupAddressComplete,
      yourCommissionRate: commissionRate,
      minimumProductPrice: settings.minimumProductPrice || 200,
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
    const products = await Product.find({ sellerId: req.user._id }).sort({ createdAt: -1 }).lean();
    res.json({ products });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.post('/products', productCreationLimiter, upload.array('media', 15), sanitizeBody, async (req, res) => {
  const allUploadedPublicIds = []; // Track for cleanup on failure
  try {
    // Require bank details before allowing product creation
    const bank = req.user.sellerProfile?.bankDetails;
    const hasBankDetails = bank?.accountHolderName && bank?.accountNumber && bank?.ifscCode && bank?.bankName;
    if (!hasBankDetails) {
      return res.status(400).json({
        message: 'Please add your bank account details in Settings before creating products.',
        code: 'BANK_DETAILS_REQUIRED'
      });
    }

    // Require pickup address for Shiprocket shipping
    const pickup = req.user.sellerProfile?.pickupAddress;
    const hasPickupAddress = pickup?.street && pickup?.city && pickup?.pincode;
    if (!hasPickupAddress) {
      return res.status(400).json({
        message: 'Please add your pickup address in Settings before creating products. This is required for shipping.',
        code: 'PICKUP_ADDRESS_REQUIRED'
      });
    }

    const sellerId = req.user._id;
    const data = { ...req.body };
    // Strip fields that sellers must not control
    delete data.isFeatured;
    delete data.orderCount;
    delete data.viewCount;
    delete data.averageRating;
    delete data.reviewCount;
    delete data.isActive; // admin-controlled on create
    data.sellerId = sellerId;
    data.slug = slugify(data.title);

    const sellerFolder = `giftsity/products/${sellerId}`;
    const uploadedImages = [];
    const uploadedMedia = [];

    // Handle uploaded files (images + videos via multipart)
    if (req.files && req.files.length > 0) {
      // Validate MIME types before processing any files
      for (const file of req.files) {
        const isVideo = file.mimetype.startsWith('video/');
        if (isVideo && !ALLOWED_VIDEO_MIMES.includes(file.mimetype)) {
          return res.status(400).json({ message: `Invalid video type: ${file.mimetype}. Allowed: ${ALLOWED_VIDEO_MIMES.join(', ')}` });
        }
        if (!isVideo && !ALLOWED_IMAGE_MIMES.includes(file.mimetype)) {
          return res.status(400).json({ message: `Invalid image type: ${file.mimetype}. Allowed: ${ALLOWED_IMAGE_MIMES.join(', ')}` });
        }
      }

      // Upload all files in parallel for speed
      const uploadPromises = req.files.map(file => {
        const base64 = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
        const isVideo = file.mimetype.startsWith('video/');
        return isVideo
          ? uploadVideo(base64, { folder: `${sellerFolder}/videos` }).then(r => ({ ...r, _isVideo: true }))
          : uploadImage(base64, { folder: sellerFolder }).then(r => ({ ...r, _isVideo: false }));
      });
      const results = await Promise.all(uploadPromises);
      for (const result of results) {
        if (result._isVideo) {
          allUploadedPublicIds.push({ publicId: result.publicId, type: 'video' });
          uploadedMedia.push({ type: 'video', url: result.url, thumbnailUrl: result.thumbnailUrl, publicId: result.publicId, duration: result.duration, width: result.width, height: result.height });
        } else {
          allUploadedPublicIds.push({ publicId: result.publicId, type: 'image' });
          uploadedImages.push(result);
          uploadedMedia.push({ type: 'image', url: result.url, publicId: result.publicId, width: result.width || 0, height: result.height || 0 });
        }
      }
    }

    // Also handle base64 strings sent in body (backward compat)
    const MAX_BASE64_IMAGE_SIZE = 10 * 1024 * 1024; // ~7.5MB decoded
    const MAX_BASE64_VIDEO_SIZE = 40 * 1024 * 1024; // ~30MB decoded (base64 is ~33% larger)

    // Validate sizes before uploading
    if (data.newImages && Array.isArray(data.newImages)) {
      for (const img of data.newImages) {
        if (typeof img === 'string' && img.startsWith('data:') && img.length > MAX_BASE64_IMAGE_SIZE) {
          return res.status(400).json({ message: 'Base64 image too large (max ~7.5MB)' });
        }
      }
    }
    if (data.newVideos && Array.isArray(data.newVideos)) {
      for (const vid of data.newVideos) {
        if (typeof vid === 'string' && vid.startsWith('data:') && vid.length > MAX_BASE64_VIDEO_SIZE) {
          return res.status(400).json({ message: 'Video too large (max 30MB)' });
        }
      }
    }

    // Upload base64 images and videos in parallel
    const base64Promises = [];
    if (data.newImages && Array.isArray(data.newImages)) {
      for (const img of data.newImages) {
        if (typeof img === 'string' && img.startsWith('data:')) {
          base64Promises.push(uploadImage(img, { folder: sellerFolder }).then(r => ({ ...r, _isVideo: false })));
        }
      }
      delete data.newImages;
    }
    if (data.newVideos && Array.isArray(data.newVideos)) {
      for (const vid of data.newVideos) {
        if (typeof vid === 'string' && vid.startsWith('data:')) {
          base64Promises.push(uploadVideo(vid, { folder: `${sellerFolder}/videos` }).then(r => ({ ...r, _isVideo: true })));
        }
      }
      delete data.newVideos;
    }
    if (base64Promises.length > 0) {
      const base64Results = await Promise.all(base64Promises);
      for (const result of base64Results) {
        if (result._isVideo) {
          allUploadedPublicIds.push({ publicId: result.publicId, type: 'video' });
          uploadedMedia.push({ type: 'video', url: result.url, thumbnailUrl: result.thumbnailUrl, publicId: result.publicId, duration: result.duration, width: result.width, height: result.height });
        } else {
          allUploadedPublicIds.push({ publicId: result.publicId, type: 'image' });
          uploadedImages.push(result);
          uploadedMedia.push({ type: 'image', url: result.url, publicId: result.publicId });
        }
      }
    }

    if (uploadedImages.length > 0) data.images = uploadedImages;
    if (uploadedMedia.length > 0) data.media = uploadedMedia;

    // Parse numeric fields from FormData strings
    if (data.price) data.price = Number(data.price);
    if (data.stock) data.stock = Number(data.stock);
    if (data.weight) data.weight = Number(data.weight);

    // Validate minimum product price from platform settings
    const platformSettings = await PlatformSettings.getSettings();
    if (data.price < (platformSettings.minimumProductPrice || 0)) {
      return res.status(400).json({ message: `Minimum product price is Rs. ${platformSettings.minimumProductPrice}` });
    }

    // Parse customization fields from FormData
    data.isCustomizable = data.isCustomizable === 'true' || data.isCustomizable === true;
    if (data.customizationOptions && typeof data.customizationOptions === 'string') {
      try { data.customizationOptions = JSON.parse(data.customizationOptions); } catch (e) { data.customizationOptions = []; }
    }
    if (!data.isCustomizable) data.customizationOptions = [];

    const product = new Product(data);
    await product.save();
    invalidateCache('/api/products');
    invalidateCache('/api/store/');
    logActivity({ domain: 'seller', action: 'product_created', actorRole: 'seller', actorId: req.user._id, actorEmail: req.user.email, targetType: 'Product', targetId: product._id, message: `Product "${product.title}" created` });
    submitToIndexNow(`https://giftsity.com/product/${product.slug}`);
    res.status(201).json({ product, message: 'Product created' });
  } catch (err) {
    // Cleanup orphaned uploads if product save failed
    for (const item of allUploadedPublicIds) {
      await deleteMedia(item.publicId, item.type).catch(() => {});
    }
    logger.error('Create product error:', err.message);
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
    // Strip fields that sellers must not control
    delete data.isFeatured;
    delete data.sellerId;
    delete data.orderCount;
    delete data.viewCount;
    delete data.averageRating;
    delete data.reviewCount;
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
      // Validate MIME types before processing any files
      for (const file of req.files) {
        const isVideo = file.mimetype.startsWith('video/');
        if (isVideo && !ALLOWED_VIDEO_MIMES.includes(file.mimetype)) {
          return res.status(400).json({ message: `Invalid video type: ${file.mimetype}. Allowed: ${ALLOWED_VIDEO_MIMES.join(', ')}` });
        }
        if (!isVideo && !ALLOWED_IMAGE_MIMES.includes(file.mimetype)) {
          return res.status(400).json({ message: `Invalid image type: ${file.mimetype}. Allowed: ${ALLOWED_IMAGE_MIMES.join(', ')}` });
        }
      }

      // Upload all files in parallel for speed
      const uploadPromises = req.files.map(file => {
        const base64 = `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
        const isVideo = file.mimetype.startsWith('video/');
        return isVideo
          ? uploadVideo(base64, { folder: `${sellerFolder}/videos` }).then(r => ({ ...r, _isVideo: true }))
          : uploadImage(base64, { folder: sellerFolder }).then(r => ({ ...r, _isVideo: false }));
      });
      const results = await Promise.all(uploadPromises);
      for (const result of results) {
        if (result._isVideo) {
          newUploadedPublicIds.push({ publicId: result.publicId, type: 'video' });
          uploadedMedia.push({ type: 'video', url: result.url, thumbnailUrl: result.thumbnailUrl, publicId: result.publicId, duration: result.duration, width: result.width, height: result.height });
        } else {
          newUploadedPublicIds.push({ publicId: result.publicId, type: 'image' });
          uploadedImages.push(result);
          uploadedMedia.push({ type: 'image', url: result.url, publicId: result.publicId });
        }
      }
    }

    // Validate base64 sizes before uploading
    if (data.newImages && Array.isArray(data.newImages)) {
      for (const img of data.newImages) {
        if (typeof img === 'string' && img.startsWith('data:') && img.length > 10 * 1024 * 1024) {
          return res.status(400).json({ message: 'Base64 image too large (max ~7.5MB)' });
        }
      }
    }
    if (data.newVideos && Array.isArray(data.newVideos)) {
      for (const vid of data.newVideos) {
        if (typeof vid === 'string' && vid.startsWith('data:') && vid.length > 40 * 1024 * 1024) {
          return res.status(400).json({ message: 'Video too large (max 30MB)' });
        }
      }
    }

    // Upload base64 images and videos in parallel
    const base64Promises = [];
    if (data.newImages && Array.isArray(data.newImages)) {
      for (const img of data.newImages) {
        if (typeof img === 'string' && img.startsWith('data:')) {
          base64Promises.push(uploadImage(img, { folder: sellerFolder }).then(r => ({ ...r, _isVideo: false })));
        }
      }
      delete data.newImages;
    }
    if (data.newVideos && Array.isArray(data.newVideos)) {
      for (const vid of data.newVideos) {
        if (typeof vid === 'string' && vid.startsWith('data:')) {
          base64Promises.push(uploadVideo(vid, { folder: `${sellerFolder}/videos` }).then(r => ({ ...r, _isVideo: true })));
        }
      }
      delete data.newVideos;
    }
    if (base64Promises.length > 0) {
      const base64Results = await Promise.all(base64Promises);
      for (const result of base64Results) {
        if (result._isVideo) {
          newUploadedPublicIds.push({ publicId: result.publicId, type: 'video' });
          uploadedMedia.push({ type: 'video', url: result.url, thumbnailUrl: result.thumbnailUrl, publicId: result.publicId, duration: result.duration, width: result.width, height: result.height });
        } else {
          newUploadedPublicIds.push({ publicId: result.publicId, type: 'image' });
          uploadedImages.push(result);
          uploadedMedia.push({ type: 'image', url: result.url, publicId: result.publicId });
        }
      }
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

    // Validate minimum product price from platform settings
    if (data.price) {
      const platformSettings = await PlatformSettings.getSettings();
      if (data.price < (platformSettings.minimumProductPrice || 0)) {
        return res.status(400).json({ message: `Minimum product price is Rs. ${platformSettings.minimumProductPrice}` });
      }
    }

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
    invalidateCache('/api/products');
    invalidateCache('/api/store/');
    logActivity({ domain: 'seller', action: 'product_updated', actorRole: 'seller', actorId: req.user._id, actorEmail: req.user.email, targetType: 'Product', targetId: product._id, message: `Product "${product.title}" updated` });
    if (product.slug) submitToIndexNow(`https://giftsity.com/product/${product.slug}`);
    res.json({ product, message: 'Product updated' });
  } catch (err) {
    // Cleanup newly uploaded files if save failed
    for (const item of newUploadedPublicIds) {
      await deleteMedia(item.publicId, item.type).catch(() => {});
    }
    logger.error('Update product error:', err.message);
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
    invalidateCache('/api/products');
    invalidateCache('/api/store/');
    logActivity({ domain: 'seller', action: 'product_deleted', actorRole: 'seller', actorId: req.user._id, actorEmail: req.user.email, targetType: 'Product', targetId: req.params.id, message: `Product deleted` });
    if (product.slug) submitToIndexNow(`https://giftsity.com/product/${product.slug}`);
    res.json({ message: 'Product deleted' });
  } catch (err) {
    logger.error('Delete product error:', err.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// =================== BULK CSV UPLOAD ===================
const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB max CSV
const sanitizeHtml = require('sanitize-html');
const csvClean = (str, maxLen = 500) => sanitizeHtml(str || '', { allowedTags: [], allowedAttributes: {} }).substring(0, maxLen);

router.post('/products/bulk-csv', csvUploadLimiter, csvUpload.single('csv'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No CSV file provided' });

    // Validate MIME type to prevent non-CSV uploads
    if (!['text/csv', 'application/vnd.ms-excel', 'text/plain'].includes(req.file.mimetype)) {
      return res.status(400).json({ message: 'Invalid file type. Only CSV files are allowed.' });
    }

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
    const csvSettings = await PlatformSettings.getSettings();
    const csvMinPrice = csvSettings.minimumProductPrice || 0;
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
        if (price < csvMinPrice) { results.errors.push({ row: i + 1, error: `Price must be at least Rs. ${csvMinPrice}` }); results.failed++; continue; }
        const stock = parseInt(row.stock);
        if (isNaN(stock) || stock < 0) { results.errors.push({ row: i + 1, error: 'Invalid stock' }); results.failed++; continue; }

        const categoryId = catMap[row.category.toLowerCase()];
        if (!categoryId) { results.errors.push({ row: i + 1, error: `Category "${row.category}" not found` }); results.failed++; continue; }

        const cleanTitle = csvClean(row.title, 200);
        const cleanDescription = csvClean(row.description, 5000);
        const cleanSku = csvClean(row.sku, 100);
        const slug = slugify(cleanTitle);
        const product = new Product({
          title: cleanTitle,
          description: cleanDescription,
          price,
          compareAtPrice: row.compareatprice ? parseFloat(row.compareatprice) : undefined,
          stock,
          category: categoryId,
          sellerId: req.user._id,
          slug,
          sku: cleanSku,
          tags: row.tags ? row.tags.split(';').map(t => csvClean(t, 50)).filter(Boolean) : [],
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
    logger.error('Bulk CSV error:', err.message);
    res.status(500).json({ message: 'Failed to process CSV' });
  }
});

// =================== ORDERS ===================
router.get('/orders', async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = { sellerId: req.user._id };
    if (status && typeof status === 'string') filter.status = status;

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const orders = await Order.find(filter).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)).populate('customerId', 'name email phone').lean();
    const total = await Order.countDocuments(filter);

    res.json({ orders, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET single order detail (includes customer shipping address for manual shipment)
router.get('/orders/:id', async (req, res) => {
  try {
    const order = await Order.findOne({ _id: req.params.id, sellerId: req.user._id })
      .populate('customerId', 'name email phone')
      .lean();
    if (!order) return res.status(404).json({ message: 'Order not found' });
    res.json(order);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

router.put('/orders/:id/status', async (req, res) => {
  try {
    const { status } = req.body;
    const order = await Order.findOne({ _id: req.params.id, sellerId: req.user._id });
    if (!order) return res.status(404).json({ message: 'Order not found' });

    const transitions = { pending: ['confirmed', 'cancelled'], confirmed: ['processing', 'shipped', 'cancelled'], shipped: ['delivered'], processing: ['shipped', 'cancelled'] };
    const allowed = transitions[order.status] || [];
    if (!allowed.includes(status)) return res.status(400).json({ message: `Cannot change from ${order.status} to ${status}` });

    order.status = status;
    if (status === 'cancelled') {
      order.cancelledAt = new Date();
      const shipment = await Shipment.findOne({ orderId: order._id, sellerId: req.user._id });
      if (shipment && shipment.shiprocketOrderId) {
        const pickedUp = ['picked_up', 'in_transit', 'out_for_delivery', 'delivered'];
        if (pickedUp.includes(shipment.status)) {
          return res.status(400).json({
            message: `Cannot cancel — package already ${shipment.status.replace(/_/g, ' ')} by courier`
          });
        }
        try {
          await shiprocket.cancelShiprocketOrder({ shiprocketOrderId: shipment.shiprocketOrderId });
        } catch (e) {
          logger.warn(`[Shipping] Shiprocket cancel failed for order ${order.orderNumber}: ${e.message}`);
        }
        shipment.status = 'cancelled';
        shipment.statusHistory.push({ status: 'cancelled', description: 'Cancelled by seller' });
        await shipment.save();
      }

      // Restore reserved stock
      for (const item of order.items) {
        const stockInc = { stock: item.quantity };
        if (order.paymentStatus === 'paid') stockInc.orderCount = -item.quantity;
        await Product.findByIdAndUpdate(item.productId, { $inc: stockInc });
      }

      // Initiate Cashfree refund if payment was completed
      if (order.paymentStatus === 'paid' && order.cashfreeOrderId) {
        try {
          let refundAmount = order.totalAmount;
          try {
            const cfOrderData = await getCashfreeOrder(order.cashfreeOrderId);
            if (cfOrderData.order_amount) {
              refundAmount = Math.min(order.totalAmount, parseFloat(cfOrderData.order_amount));
            }
          } catch (cfErr) {
            logger.warn(`[Refund] Could not verify Cashfree amount: ${cfErr.message}`);
          }
          const refundId = `refund_${order.orderNumber}_${Date.now()}`;
          await createRefund({ orderId: order.cashfreeOrderId, refundAmount, refundId, refundNote: 'Order cancelled by seller' });
          order.paymentStatus = 'refunded';
          order.refundId = refundId;
        } catch (refundErr) {
          logger.error(`[Refund] Failed for seller-cancel ${order.orderNumber}:`, refundErr.message);
          order.paymentStatus = 'refund_pending';
        }
      }
    }
    if (status === 'delivered') {
      order.deliveredAt = new Date();
      // Send delivered email
      try {
        const { sendDeliveredEmail } = require('../../server/utils/email');
        if (order.customerEmail) await sendDeliveredEmail(order.customerEmail, order);
      } catch (e) { logger.error('Delivered email error:', e.message); }
    }
    if (!order.statusHistory) order.statusHistory = [];
    order.statusHistory.push({ status, timestamp: new Date(), changedBy: req.user._id, changedByRole: 'seller', note: `Marked ${status} by seller` });
    await order.save();

    // Send corporate order status email for B2B orders
    if (order.orderType === 'b2b_direct' && ['shipped', 'delivered', 'cancelled'].includes(status)) {
      try {
        const { sendCorporateOrderStatusEmail } = require('../../server/utils/email');
        if (order.customerEmail) await sendCorporateOrderStatusEmail(order.customerEmail, order, status);
      } catch (e) { logger.error('Corporate status email error:', e.message); }
    }

    // Notify customer about status change
    const statusNotifTypes = { delivered: 'order_delivered', shipped: 'order_shipped', cancelled: 'order_cancelled' };
    if (statusNotifTypes[status] && order.customerId) {
      createNotification({
        userId: order.customerId.toString(), userRole: 'customer',
        type: statusNotifTypes[status],
        title: `Order #${order.orderNumber} ${status}`,
        message: status === 'delivered' ? 'Your order has been delivered!' : status === 'cancelled' ? 'Your order has been cancelled' : `Your order has been ${status}`,
        link: `/orders/${order._id}`, metadata: { orderId: order._id.toString() }
      });
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

    const { isValidTransition } = require('../../server/utils/orderStatus');
    if (!isValidTransition(order.status, 'shipped')) {
      return res.status(400).json({ message: `Cannot ship order with status "${order.status}"` });
    }

    order.status = 'shipped';
    order.trackingInfo = {
      courierName: courierName || '',
      trackingNumber: trackingNumber || '',
      shippedAt: new Date(),
      estimatedDelivery: estimatedDelivery ? new Date(estimatedDelivery) : null
    };
    if (!order.statusHistory) order.statusHistory = [];
    order.statusHistory.push({ status: 'shipped', timestamp: new Date(), changedBy: req.user._id, changedByRole: 'seller', note: `Shipped via ${courierName || 'courier'}` });
    await order.save();

    // Send shipped email
    try {
      const { sendShippedEmail } = require('../../server/utils/email');
      if (order.customerEmail) await sendShippedEmail(order.customerEmail, order);
    } catch (e) { logger.error('Shipped email error:', e.message); }

    // Send corporate order status email for B2B orders
    if (order.orderType === 'b2b_direct') {
      try {
        const { sendCorporateOrderStatusEmail } = require('../../server/utils/email');
        if (order.customerEmail) await sendCorporateOrderStatusEmail(order.customerEmail, order, 'shipped');
      } catch (e) { logger.error('Corporate shipped email error:', e.message); }
    }

    logActivity({ domain: 'seller', action: 'order_shipped', actorRole: 'seller', actorId: req.user._id, actorEmail: req.user.email, targetType: 'Order', targetId: order._id, message: `Order ${order.orderNumber} shipped via ${courierName || 'unknown'}`, metadata: { courierName, trackingNumber } });

    createNotification({
      userId: order.customerId.toString(), userRole: 'customer',
      type: 'order_shipped', title: `Order #${order.orderNumber} shipped`,
      message: `Your order has been shipped${trackingNumber ? ` (Tracking: ${trackingNumber})` : ''}`,
      link: `/orders/${order._id}`, metadata: { orderId: order._id.toString() }
    });

    res.json({ order, message: 'Order marked as shipped' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// =================== PAYOUTS ===================
router.get('/payouts', async (req, res) => {
  try {
    const payouts = await SellerPayout.find({ sellerId: req.user._id }).sort({ createdAt: -1 }).lean();
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
    if (bankDetails) {
      // Validate bank details
      if (bankDetails.ifscCode) {
        const ifscRegex = /^[A-Z]{4}0[A-Z0-9]{6}$/;
        if (!ifscRegex.test(bankDetails.ifscCode.toUpperCase())) {
          return res.status(400).json({ message: 'Invalid IFSC code. Must be 11 characters (e.g., SBIN0001234).' });
        }
        bankDetails.ifscCode = bankDetails.ifscCode.toUpperCase();
      }
      if (bankDetails.accountNumber) {
        const acctClean = bankDetails.accountNumber.replace(/\s/g, '');
        if (!/^\d{9,18}$/.test(acctClean)) {
          return res.status(400).json({ message: 'Invalid account number. Must be 9-18 digits.' });
        }
        bankDetails.accountNumber = acctClean;
      }
      user.sellerProfile.bankDetails = bankDetails;

      // Auto-unhold payouts when bank details are added/fixed
      const isBankComplete = bankDetails.accountHolderName && bankDetails.accountNumber && bankDetails.ifscCode && bankDetails.bankName;
      if (isBankComplete) {
        try {
          const SellerPayout = require('../../server/models/SellerPayout');
          const onHoldPayouts = await SellerPayout.find({ sellerId: user._id, status: 'on_hold', holdReason: 'missing_bank_details' });
          for (const payout of onHoldPayouts) {
            payout.status = 'pending';
            payout.holdReason = '';
            payout.bankDetailsSnapshot = bankDetails;
            await payout.save();
          }
          if (onHoldPayouts.length > 0) {
            logger.info(`[Payout] Auto-unhold ${onHoldPayouts.length} payouts for seller ${user._id} after bank details update`);
          }
        } catch (payoutErr) {
          logger.warn('[Payout] Failed to auto-unhold payouts:', payoutErr.message);
        }
      }
    }
    if (bio !== undefined) user.sellerProfile.bio = bio;
    if (phone) user.phone = phone;
    if (businessType !== undefined) user.sellerProfile.businessType = businessType;
    if (gstNumber !== undefined) user.sellerProfile.gstNumber = gstNumber;
    if (instagramUsername !== undefined) {
      const cleanUsername = instagramUsername.replace('@', '').trim();
      if (cleanUsername && cleanUsername !== user.sellerProfile.instagramUsername) {
        // Verify Instagram username exists
        try {
          const { verifyInstagramUsername } = require('../../server/utils/instagram');
          const igResult = await verifyInstagramUsername(cleanUsername);
          if (!igResult.exists) {
            return res.status(400).json({ message: `Instagram account @${cleanUsername} not found. Please enter a valid username.` });
          }
          user.sellerProfile.instagramVerified = true;
        } catch (igErr) {
          logger.warn('[Instagram] Verification failed, allowing save:', igErr.message);
          // Allow save if verification service is down
        }
      }
      user.sellerProfile.instagramUsername = cleanUsername;
    }

    // Register/update Shiprocket pickup location when pickupAddress changes
    // Skip Shiprocket operations for suspended sellers
    let shiprocketPickupStatus = null;
    let shiprocketError = null;
    if (pickupAddress && pickupAddress.street && pickupAddress.city && pickupAddress.pincode && user.status !== 'suspended') {
      const pickupPhone = pickupAddress.phone || user.phone;
      if (!pickupPhone) {
        // Phone is required for Shiprocket pickup registration
        await user.save();
        return res.status(400).json({
          message: 'Phone number is required for pickup address. Please add a phone number.',
          shiprocketPickupStatus: 'phone_required'
        });
      }

      // Normalize state name for Shiprocket compatibility
      const { normalizeState } = require('../../server/utils/indianStates');
      const normalizedState = normalizeState(pickupAddress.state);

      const locationName = `seller-${user._id.toString().slice(-8)}`;
      const locationPayload = {
        pickupLocationName: locationName,
        name: user.sellerProfile.businessName || user.name || locationName,
        email: user.email,
        phone: pickupPhone,
        address: pickupAddress.street,
        city: pickupAddress.city,
        state: normalizedState,
        pinCode: pickupAddress.pincode,
        country: 'India'
      };

      try {
        const addResult = await shiprocket.addPickupLocation(locationPayload);
        user.sellerProfile.shiprocketPickupLocation = locationName;
        shiprocketPickupStatus = 'registered';
        logger.info(`[Shiprocket] Registered pickup "${locationName}" for seller ${user._id}:`, JSON.stringify(addResult));
      } catch (pickupErr) {
        const errMsg = pickupErr?.response?.data?.message || pickupErr?.response?.data?.errors || pickupErr.message || '';
        const errStr = typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg);
        logger.warn(`[Shiprocket] addPickupLocation failed for seller ${user._id}:`, errStr);

        // If duplicate/already exists, try to update the existing location instead
        if (errStr.toLowerCase().includes('already') || errStr.toLowerCase().includes('duplicate') || errStr.toLowerCase().includes('exists')) {
          try {
            // updatePickupLocation now auto-resolves pickup_id from getPickupLocations()
            const updateResult = await shiprocket.updatePickupLocation(locationPayload);
            user.sellerProfile.shiprocketPickupLocation = locationName;
            shiprocketPickupStatus = 'updated';
            logger.info(`[Shiprocket] Updated existing pickup "${locationName}" for seller ${user._id}:`, JSON.stringify(updateResult));
          } catch (updateErr) {
            const updateErrMsg = updateErr?.response?.data?.message || updateErr?.response?.data?.errors || updateErr.message || '';
            const updateErrStr = typeof updateErrMsg === 'string' ? updateErrMsg : JSON.stringify(updateErrMsg);
            logger.error(`[Shiprocket] updatePickupLocation also failed for seller ${user._id}:`, updateErrStr);
            // Still set the location name since the location exists on Shiprocket
            user.sellerProfile.shiprocketPickupLocation = locationName;
            shiprocketPickupStatus = 'exists_update_failed';
            shiprocketError = `Address exists on Shiprocket but update failed: ${updateErrStr}`;
          }
        } else {
          logger.error('[Shiprocket] Failed to register pickup (non-duplicate error):', errStr);
          shiprocketPickupStatus = 'failed';
          shiprocketError = `Shiprocket registration failed: ${errStr}`;
        }
      }

      // Check pickup phone verification status from Shiprocket
      try {
        const locations = await shiprocket.getPickupLocations();
        const thisLocation = locations.find(l => l.pickup_location === locationName);
        if (thisLocation) {
          const isVerified = thisLocation.phone_verified === 1;
          user.sellerProfile.shiprocketPickupVerified = isVerified;
          logger.info(`[Shiprocket] Pickup "${locationName}" phone_verified=${thisLocation.phone_verified} (${isVerified ? 'verified' : 'unverified'})`);
        }
      } catch (verifyErr) {
        logger.warn('[Shiprocket] Could not check pickup verification status:', verifyErr.message);
      }
    }

    await user.save();
    invalidateCache('/api/store/');
    const response = {
      message: 'Settings updated',
      shiprocketPickupStatus,
      shiprocketPickupVerified: user.sellerProfile.shiprocketPickupVerified || false
    };
    if (shiprocketError) response.shiprocketError = shiprocketError;
    res.json(response);
  } catch (err) {
    logger.error('Settings update error:', err.message);
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
    logger.error('Seller upload image error:', err);
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
    let couriers = companies.map(c => ({
      courierId: c.courier_company_id,
      courierName: c.courier_name,
      rate: c.rate,
      estimatedDays: c.estimated_delivery_days,
      etd: c.etd,
      rating: c.rating
    }));

    // Cap courier selection: when customer paid for shipping, only show couriers within budget
    const shippingBudget = order.shippingPaidBy === 'customer' ? (order.actualShippingCost || order.shippingCost || 0) : null;
    if (shippingBudget && shippingBudget > 0) {
      couriers = couriers.filter(c => c.rate <= shippingBudget);
      logger.info(`[Shipping] Filtered to ${couriers.length} couriers within budget Rs. ${shippingBudget}`);
    }

    logger.info('[Shipping] Returning', couriers.length, 'couriers');
    res.json({ couriers, pickupPincode, deliveryPincode, shippingBudget });
  } catch (err) {
    logger.error('Serviceability error:', err?.response?.data || err.message);
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

    // Block shipment if pickup address is not phone-verified on Shiprocket
    if (!seller.sellerProfile?.shiprocketPickupVerified) {
      // Double-check with Shiprocket API in case it was verified recently
      const locationName = seller.sellerProfile?.shiprocketPickupLocation;
      let justVerified = false;
      if (locationName) {
        try {
          const locations = await shiprocket.getPickupLocations();
          const loc = locations.find(l => l.pickup_location === locationName);
          if (loc && loc.phone_verified === 1) {
            seller.sellerProfile.shiprocketPickupVerified = true;
            await seller.save();
            justVerified = true;
          }
        } catch (e) {
          logger.warn('[Shiprocket] Could not re-check pickup verification:', e.message);
        }
      }
      if (!justVerified) {
        return res.status(400).json({
          message: 'Your pickup address phone is not verified on Shiprocket. Please verify it in Seller Settings before creating shipments.',
          code: 'PICKUP_UNVERIFIED'
        });
      }
    }

    // Validate and clamp weight/dimensions to reasonable bounds
    const weight = Math.max(50, Math.min(50000, Number(req.body.weight) || 500));   // 50g to 50kg
    const length = Math.max(1, Math.min(200, Number(req.body.length) || 10));       // 1cm to 200cm
    const width = Math.max(1, Math.min(200, Number(req.body.width) || 10));         // 1cm to 200cm
    const height = Math.max(1, Math.min(200, Number(req.body.height) || 10));       // 1cm to 200cm

    // Use seller's registered Shiprocket pickup location, fall back to fetching from API
    let pickupLocationName = seller.sellerProfile?.shiprocketPickupLocation || '';
    if (!pickupLocationName) {
      try {
        const pickupLocations = await shiprocket.getPickupLocations();
        const active = pickupLocations.find(loc => loc.status === 2) || pickupLocations[0];
        if (active?.pickup_location) {
          pickupLocationName = active.pickup_location;
        }
      } catch (pickupErr) {
        logger.warn('[Shiprocket] Could not fetch pickup locations:', pickupErr.message);
      }
    }
    if (!pickupLocationName) {
      return res.status(400).json({ message: 'No pickup location configured. Please save your pickup address in Seller Settings first.' });
    }
    logger.info(`[Shiprocket] Using pickup location: "${pickupLocationName}" for seller ${seller._id}`);

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
    logger.info('[Shiprocket] Create order response:', JSON.stringify(result, null, 2));

    // Extract IDs from multiple possible response formats
    const srOrderId = (result.order_id || result.payload?.order_id || '').toString();
    let srShipmentId = (result.shipment_id || result.payload?.shipment_id || '').toString();

    if (!srOrderId) {
      logger.error('[Shiprocket] No order_id in response:', result);
      return res.status(500).json({ message: 'Shiprocket did not return an order ID', shiprocketResponse: result });
    }

    // Shiprocket sometimes omits shipment_id from create response — fetch it
    if (!srShipmentId) {
      logger.warn('[Shiprocket] No shipment_id in create response, fetching order details...');
      await new Promise(r => setTimeout(r, 1500));
      try {
        const details = await shiprocket.getShiprocketOrderDetails(srOrderId);
        const shipments = details?.data?.shipments || details?.shipments || [];
        if (shipments.length > 0) {
          srShipmentId = shipments[0].id?.toString() || '';
          logger.info(`[Shiprocket] Fetched shipment_id=${srShipmentId} from order details`);
        }
      } catch (fetchErr) {
        logger.warn('[Shiprocket] Could not fetch order details:', fetchErr.message);
      }
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
      logger.warn('[Shiprocket] shipment_id still missing after retry — courier assignment will fail until resolved.');
    }

    order.status = 'processing';
    await order.save();

    res.json({ message: 'Shipment created', shipment, warning: !srShipmentId ? 'Shipment created but courier assignment may need a retry' : undefined });
  } catch (err) {
    logger.error('Create shipment error:', err?.response?.data || err.message);
    res.status(500).json({ message: 'Failed to create shipment', error: err?.response?.data?.message || err.message });
  }
});

router.post('/shipping/:orderId/assign-courier', async (req, res) => {
  try {
    const { courierId, courierRate } = req.body;
    const shipment = await Shipment.findOne({ orderId: req.params.orderId, sellerId: req.user._id });
    if (!shipment) return res.status(404).json({ message: 'Shipment not found' });

    if (!shipment.shiprocketShipmentId && shipment.shiprocketOrderId) {
      logger.info(`[Shipping] shiprocketShipmentId missing, fetching from order ${shipment.shiprocketOrderId}...`);
      try {
        const details = await shiprocket.getShiprocketOrderDetails(shipment.shiprocketOrderId);
        const shipments = details?.data?.shipments || details?.shipments || [];
        if (shipments.length > 0 && shipments[0].id) {
          shipment.shiprocketShipmentId = shipments[0].id.toString();
          await shipment.save();
          logger.info(`[Shipping] Self-healed shiprocketShipmentId=${shipment.shiprocketShipmentId}`);
        }
      } catch (e) {
        logger.warn('[Shipping] Could not fetch order details for self-heal:', e.message);
      }
    }

    if (!shipment.shiprocketShipmentId) {
      return res.status(400).json({ message: 'Shipment ID missing — please recreate the shipment' });
    }

    const result = await shiprocket.assignCourier({ shipmentId: shipment.shiprocketShipmentId, courierId });

    shipment.awbCode = result.response?.data?.awb_code || result.awb_code || '';
    shipment.courierName = result.response?.data?.courier_name || result.courier_name || '';
    shipment.courierId = courierId;
    if (courierRate && courierRate > 0) {
      shipment.shippingCharge = Math.round(courierRate);
    }
    shipment.statusHistory.push({ status: 'courier_assigned', description: `Courier: ${shipment.courierName}` });
    await shipment.save();

    // Update order's actualShippingCost with real courier rate (used for payout deduction)
    if (courierRate && courierRate > 0) {
      const order = await Order.findById(req.params.orderId);
      if (order && order.shippingPaidBy === 'seller') {
        order.actualShippingCost = Math.round(courierRate);
        await order.save();
        logger.info(`[Shipping] Updated actualShippingCost to Rs.${Math.round(courierRate)} for order ${order.orderNumber}`);
      }
    }

    res.json({ message: 'Courier assigned', shipment });
  } catch (err) {
    logger.error('Assign courier error:', err?.response?.data || err.message);
    res.status(500).json({ message: err?.response?.data?.message || 'Failed to assign courier', error: err?.response?.data });
  }
});

router.post('/shipping/:orderId/pickup', async (req, res) => {
  try {
    const shipment = await Shipment.findOne({ orderId: req.params.orderId, sellerId: req.user._id });
    if (!shipment) return res.status(404).json({ message: 'Shipment not found' });

    try {
      const result = await shiprocket.schedulePickup({ shipmentId: shipment.shiprocketShipmentId });
      logger.info(`[Pickup] Scheduled for shipment ${shipment.shiprocketShipmentId}:`, JSON.stringify(result));
    } catch (pickupErr) {
      const errMsg = pickupErr?.response?.data?.message || pickupErr?.response?.data || pickupErr.message || '';
      const errStr = typeof errMsg === 'string' ? errMsg : JSON.stringify(errMsg);
      logger.warn(`[Pickup] Shiprocket schedulePickup error: ${errStr}`);

      // If pickup was already scheduled (auto-scheduled by Shiprocket), treat as success
      if (errStr.toLowerCase().includes('already') || errStr.toLowerCase().includes('scheduled') || errStr.toLowerCase().includes('pickup')) {
        logger.info(`[Pickup] Pickup appears already scheduled, syncing local state`);
      } else {
        // Genuine error -- pass through to seller
        return res.status(500).json({ message: errStr || 'Failed to schedule pickup' });
      }
    }

    // Update local shipment status
    shipment.status = 'pickup_scheduled';
    shipment.pickupScheduledAt = shipment.pickupScheduledAt || new Date();
    shipment.statusHistory.push({ status: 'pickup_scheduled', description: 'Pickup scheduled' });
    await shipment.save();

    // Update order to shipped
    const order = await Order.findById(req.params.orderId);
    if (order) {
      const { isValidTransition } = require('../../server/utils/orderStatus');
      if (isValidTransition(order.status, 'shipped')) {
        order.status = 'shipped';
        order.trackingInfo = { courierName: shipment.courierName, trackingNumber: shipment.awbCode, shippedAt: new Date() };
        if (!order.statusHistory) order.statusHistory = [];
        order.statusHistory.push({ status: 'shipped', timestamp: new Date(), changedBy: req.user._id, changedByRole: 'seller', note: `Shipped via ${shipment.courierName}` });
        await order.save();

        createNotification({
          userId: order.customerId.toString(), userRole: 'customer',
          type: 'order_shipped', title: `Order #${order.orderNumber} shipped`,
          message: `Your order has been shipped via ${shipment.courierName}`,
          link: `/orders/${order._id}`, metadata: { orderId: order._id.toString() }
        });
      }
    }

    res.json({ message: 'Pickup scheduled', shipment });
  } catch (err) {
    logger.error('[Pickup] Unexpected error:', err.message);
    res.status(500).json({ message: err.message || 'Failed to schedule pickup' });
  }
});

router.post('/shipping/batch-shipments', async (req, res) => {
  try {
    const { orderIds } = req.body;
    if (!Array.isArray(orderIds) || orderIds.length === 0) return res.json({ shipments: {} });
    const shipments = await Shipment.find({ orderId: { $in: orderIds }, sellerId: req.user._id }).lean();
    const map = {};
    for (const s of shipments) map[s.orderId.toString()] = s;
    res.json({ shipments: map });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
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

// =================== PICKUP VERIFICATION ===================
router.post('/shipping/verify-pickup', async (req, res) => {
  try {
    const seller = await Seller.findById(req.user._id);
    if (!seller) return res.status(404).json({ message: 'Seller not found' });

    const locationName = seller.sellerProfile?.shiprocketPickupLocation;
    if (!locationName) {
      return res.status(400).json({ message: 'No pickup location registered. Save your pickup address in Settings first.', verified: false });
    }

    const locations = await shiprocket.getPickupLocations();
    const thisLocation = locations.find(l => l.pickup_location === locationName);

    if (!thisLocation) {
      return res.json({ verified: false, message: 'Pickup location not found on Shiprocket. Try saving your address again.', locationName });
    }

    const isVerified = thisLocation.phone_verified === 1;

    // Update the seller's stored verification status
    if (seller.sellerProfile.shiprocketPickupVerified !== isVerified) {
      seller.sellerProfile.shiprocketPickupVerified = isVerified;
      await seller.save();
    }

    res.json({
      verified: isVerified,
      locationName,
      phone_verified: thisLocation.phone_verified,
      message: isVerified ? 'Pickup address is verified' : 'Pickup address phone is not verified. Please verify it on the Shiprocket dashboard.'
    });
  } catch (err) {
    logger.error('Verify pickup error:', err?.response?.data || err.message);
    res.status(500).json({ message: 'Failed to check verification status', error: err?.response?.data?.message || err.message });
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

// ==================== RETURNS ====================
const ReturnRequest = require('../../server/models/ReturnRequest');

// GET /api/seller/returns -- list return requests for seller's orders
router.get('/returns', async (req, res) => {
  try {
    const filter = { sellerId: req.user._id };
    if (req.query.status) filter.status = req.query.status;
    const requests = await ReturnRequest.find(filter)
      .sort({ createdAt: -1 })
      .populate('orderId', 'orderNumber totalAmount')
      .populate('customerId', 'name email phone')
      .lean();
    res.json({ requests });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/seller/returns/:id/approve
router.put('/returns/:id/approve', async (req, res) => {
  try {
    const returnReq = await ReturnRequest.findById(req.params.id);
    if (!returnReq) return res.status(404).json({ message: 'Return request not found' });
    if (returnReq.sellerId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not your return request' });
    }
    if (returnReq.status !== 'requested') {
      return res.status(400).json({ message: 'Can only approve requested returns' });
    }

    returnReq.status = 'approved';
    returnReq.statusHistory.push({
      status: 'approved', timestamp: new Date(),
      changedBy: req.user._id, changedByRole: 'seller',
      note: req.body.note || 'Approved by seller'
    });
    await returnReq.save();

    // Update order
    await Order.findByIdAndUpdate(returnReq.orderId, {
      returnStatus: 'approved',
      $push: { statusHistory: { status: 'return_approved', timestamp: new Date(), changedBy: req.user._id, changedByRole: 'seller', note: 'Return approved' } }
    });

    createNotification({
      userId: returnReq.customerId.toString(),
      userRole: 'customer',
      type: 'return_approved',
      title: 'Return request approved',
      message: 'Your return request has been approved. Please ship the item back.',
      link: `/returns/${returnReq._id}`,
      metadata: { returnRequestId: returnReq._id.toString() }
    });

    logActivity({ domain: 'order', action: 'return_approved', actorRole: 'seller', actorId: req.user._id, actorEmail: req.user.email, targetType: 'ReturnRequest', targetId: returnReq._id, message: 'Return approved by seller' });

    res.json({ message: 'Return approved', returnRequest: returnReq });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/seller/returns/:id/reject
router.put('/returns/:id/reject', async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ message: 'Rejection reason required' });

    const returnReq = await ReturnRequest.findById(req.params.id);
    if (!returnReq) return res.status(404).json({ message: 'Return request not found' });
    if (returnReq.sellerId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not your return request' });
    }
    if (returnReq.status !== 'requested') {
      return res.status(400).json({ message: 'Can only reject requested returns' });
    }

    returnReq.status = 'rejected';
    returnReq.rejectionReason = reason;
    returnReq.resolvedAt = new Date();
    returnReq.statusHistory.push({
      status: 'rejected', timestamp: new Date(),
      changedBy: req.user._id, changedByRole: 'seller',
      note: reason
    });
    await returnReq.save();

    await Order.findByIdAndUpdate(returnReq.orderId, {
      returnStatus: 'rejected',
      $push: { statusHistory: { status: 'return_rejected', timestamp: new Date(), changedBy: req.user._id, changedByRole: 'seller', note: reason } }
    });

    createNotification({
      userId: returnReq.customerId.toString(),
      userRole: 'customer',
      type: 'return_rejected',
      title: 'Return request rejected',
      message: `Reason: ${reason}`,
      link: `/returns/${returnReq._id}`,
      metadata: { returnRequestId: returnReq._id.toString() }
    });

    logActivity({ domain: 'order', action: 'return_rejected', actorRole: 'seller', actorId: req.user._id, actorEmail: req.user.email, targetType: 'ReturnRequest', targetId: returnReq._id, message: `Return rejected: ${reason}` });

    res.json({ message: 'Return rejected', returnRequest: returnReq });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// PUT /api/seller/returns/:id/received -- mark item received, trigger refund
router.put('/returns/:id/received', async (req, res) => {
  try {
    const returnReq = await ReturnRequest.findById(req.params.id);
    if (!returnReq) return res.status(404).json({ message: 'Return request not found' });
    if (returnReq.sellerId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not your return request' });
    }
    if (!['approved', 'shipped_back'].includes(returnReq.status)) {
      return res.status(400).json({ message: 'Item must be approved or shipped back first' });
    }

    const order = await Order.findById(returnReq.orderId);

    returnReq.status = 'received';
    returnReq.statusHistory.push({
      status: 'received', timestamp: new Date(),
      changedBy: req.user._id, changedByRole: 'seller',
      note: 'Item received by seller'
    });

    // If return type, initiate refund
    if (returnReq.type === 'return' && order && order.cashfreeOrderId && returnReq.refundAmount > 0) {
      try {
        const refundId = `return_${order.orderNumber}_${Date.now()}`;
        await require('../../server/config/cashfree').createRefund({
          orderId: order.cashfreeOrderId,
          refundAmount: returnReq.refundAmount,
          refundId,
          refundNote: `Return refund for order ${order.orderNumber}`
        });
        returnReq.refundId = refundId;
        returnReq.status = 'refunded';
        returnReq.statusHistory.push({
          status: 'refunded', timestamp: new Date(),
          changedBy: req.user._id, changedByRole: 'seller',
          note: `Refund initiated: ${refundId}`
        });
        if (order) {
          order.returnStatus = 'completed';
          order.paymentStatus = 'refund_pending';
          order.refundId = refundId;
          order.statusHistory = order.statusHistory || [];
          order.statusHistory.push({ status: 'return_refunded', timestamp: new Date(), changedBy: req.user._id, changedByRole: 'seller', note: `Refund: Rs.${returnReq.refundAmount}` });
          await order.save();
        }
      } catch (refundErr) {
        // Refund failed but item was received
        returnReq.statusHistory.push({
          status: 'received', timestamp: new Date(),
          changedByRole: 'system',
          note: `Refund failed: ${refundErr.message}`
        });
      }
    } else if (returnReq.type === 'exchange') {
      returnReq.status = 'exchanged';
      returnReq.statusHistory.push({
        status: 'exchanged', timestamp: new Date(),
        changedBy: req.user._id, changedByRole: 'seller',
        note: 'Exchange item received, replacement will be shipped'
      });
      if (order) {
        order.returnStatus = 'completed';
        order.statusHistory = order.statusHistory || [];
        order.statusHistory.push({ status: 'exchange_completed', timestamp: new Date(), changedBy: req.user._id, changedByRole: 'seller', note: 'Exchange processed' });
        await order.save();
      }
    }

    returnReq.resolvedAt = new Date();
    await returnReq.save();

    createNotification({
      userId: returnReq.customerId.toString(),
      userRole: 'customer',
      type: 'return_refunded',
      title: returnReq.type === 'return' ? 'Refund initiated' : 'Exchange processed',
      message: returnReq.type === 'return' ? `Rs.${returnReq.refundAmount} refund initiated` : 'Your exchange has been processed',
      link: `/returns/${returnReq._id}`,
      metadata: { returnRequestId: returnReq._id.toString() }
    });

    logActivity({ domain: 'order', action: 'return_received', actorRole: 'seller', actorId: req.user._id, actorEmail: req.user.email, targetType: 'ReturnRequest', targetId: returnReq._id, message: `Return item received, ${returnReq.type === 'return' ? 'refund initiated' : 'exchange processed'}` });

    res.json({ message: 'Item received and processed', returnRequest: returnReq });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

module.exports = router;
