const express = require('express');
const Product = require('../../server/models/Product');
const Order = require('../../server/models/Order');
const User = require('../../server/models/User');
const SellerPayout = require('../../server/models/SellerPayout');
const PlatformSettings = require('../../server/models/PlatformSettings');
const Shipment = require('../../server/models/Shipment');
const { requireAuth, requireSeller } = require('../../server/middleware/auth');
const { uploadImage, deleteImage } = require('../../server/config/cloudinary');
const { slugify } = require('../../server/utils/slugify');
const { getCommissionRate } = require('../../server/utils/commission');
const shiprocket = require('../../server/config/shiprocket');
const router = express.Router();

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
    const freshUser = await User.findById(sellerId);
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

router.post('/products', async (req, res) => {
  try {
    const data = { ...req.body, sellerId: req.user._id };
    data.slug = slugify(data.title);

    if (data.newImages && Array.isArray(data.newImages)) {
      const uploaded = [];
      for (const img of data.newImages) {
        if (img.startsWith('data:')) {
          const result = await uploadImage(img, { folder: 'giftsity/products' });
          uploaded.push(result);
        }
      }
      data.images = uploaded;
      delete data.newImages;
    }

    const product = new Product(data);
    await product.save();
    res.status(201).json({ product, message: 'Product created' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.put('/products/:id', async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, sellerId: req.user._id });
    if (!product) return res.status(404).json({ message: 'Product not found' });

    const data = { ...req.body, updatedAt: Date.now() };

    if (data.newImages && Array.isArray(data.newImages)) {
      const uploaded = [];
      for (const img of data.newImages) {
        if (img.startsWith('data:')) {
          const result = await uploadImage(img, { folder: 'giftsity/products' });
          uploaded.push(result);
        }
      }
      data.images = [...(data.existingImages || []), ...uploaded];
      delete data.newImages;
      delete data.existingImages;
    }

    if (data.deletedImageIds && Array.isArray(data.deletedImageIds)) {
      for (const publicId of data.deletedImageIds) {
        await deleteImage(publicId);
      }
      delete data.deletedImageIds;
    }

    Object.assign(product, data);
    await product.save();
    res.json({ product, message: 'Product updated' });
  } catch (err) {
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

router.delete('/products/:id', async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, sellerId: req.user._id });
    if (!product) return res.status(404).json({ message: 'Product not found' });

    for (const img of product.images) {
      if (img.publicId) await deleteImage(img.publicId);
    }

    await Product.findByIdAndDelete(req.params.id);
    res.json({ message: 'Product deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
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
    const user = await User.findById(req.user._id);
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

router.put('/settings', async (req, res) => {
  try {
    const { businessName, businessAddress, pickupAddress, bankDetails, phone, bio } = req.body;
    const user = req.user;

    if (businessName) user.sellerProfile.businessName = businessName;
    if (businessAddress) user.sellerProfile.businessAddress = businessAddress;
    if (pickupAddress) user.sellerProfile.pickupAddress = pickupAddress;
    if (bankDetails) user.sellerProfile.bankDetails = bankDetails;
    if (bio !== undefined) user.sellerProfile.bio = bio;
    if (phone) user.phone = phone;

    await user.save();
    res.json({ message: 'Settings updated' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
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

    const seller = await User.findById(req.user._id);
    const pickupPincode = seller.sellerProfile.pickupAddress?.pincode || seller.sellerProfile.businessAddress?.pincode;
    if (!pickupPincode) return res.status(400).json({ message: 'Set your pickup address pincode first' });

    const deliveryPincode = order.shippingAddress?.pincode;
    if (!deliveryPincode) return res.status(400).json({ message: 'Order has no delivery pincode' });

    const result = await shiprocket.checkServiceability({ pickupPincode, deliveryPincode, weight: 500, cod: 0 });

    const couriers = (result.data?.available_courier_companies || []).map(c => ({
      courierId: c.courier_company_id,
      courierName: c.courier_name,
      rate: c.rate,
      estimatedDays: c.estimated_delivery_days,
      etd: c.etd,
      rating: c.rating
    }));

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

    const seller = await User.findById(req.user._id);
    const { weight = 500, length = 10, width = 10, height = 10 } = req.body;

    const shiprocketData = {
      order_id: order.orderNumber,
      order_date: new Date().toISOString().split('T')[0],
      pickup_location: 'Primary',
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
      length, width, height,
      weight: weight / 1000
    };

    const result = await shiprocket.createShiprocketOrder(shiprocketData);

    const shipment = existing || new Shipment({ orderId: order._id, sellerId: req.user._id });
    shipment.shiprocketOrderId = result.order_id?.toString() || '';
    shipment.shiprocketShipmentId = result.shipment_id?.toString() || '';
    shipment.weight = weight;
    shipment.dimensions = { length, width, height };
    shipment.status = 'created';
    shipment.statusHistory.push({ status: 'created', description: 'Shipment created on Shiprocket' });
    await shipment.save();

    order.status = 'processing';
    await order.save();

    res.json({ message: 'Shipment created', shipment });
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

    const result = await shiprocket.assignCourier({ shipmentId: shipment.shiprocketShipmentId, courierId });

    shipment.awbCode = result.response?.data?.awb_code || '';
    shipment.courierName = result.response?.data?.courier_name || '';
    shipment.courierId = courierId;
    shipment.statusHistory.push({ status: 'courier_assigned', description: `Courier: ${shipment.courierName}` });
    await shipment.save();

    res.json({ message: 'Courier assigned', shipment });
  } catch (err) {
    res.status(500).json({ message: 'Failed to assign courier' });
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
    const shipment = await Shipment.findOne({ orderId: req.params.orderId });
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

    res.json({ message: 'Suspension removal request submitted. Admin will review.' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
