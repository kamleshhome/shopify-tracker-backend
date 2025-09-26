const express = require('express');
const crypto = require('crypto');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();

// ✅ Capture raw body for HMAC before body is parsed
app.use(
  express.raw({
    type: 'application/json',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  })
);

// ✅ Enable CORS
app.use(cors());

// ✅ Firebase
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
if (serviceAccount.project_id) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log('✅ Firebase Admin SDK initialized.');
}
const db = admin.firestore();

// ✅ Shopify Webhook Secret
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

// ✅ Middleware to verify HMAC
const verifyShopifyWebhook = (req, res, next) => {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const topic = req.get('X-Shopify-Topic');
  const shop = req.get('X-Shopify-Shop-Domain');

  if (!hmac || !req.rawBody || !topic || !shop) {
    console.error('❌ Missing required headers.');
    return res.status(401).send('Unauthorized');
  }

  const generatedHash = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(req.rawBody)
    .digest('base64');

  if (generatedHash === hmac) {
    try {
      req.body = JSON.parse(req.rawBody.toString('utf8'));
      next();
    } catch (err) {
      console.error('❌ Invalid JSON body');
      return res.status(400).send('Bad Request');
    }
  } else {
    console.error('❌ HMAC mismatch.');
    return res.status(401).send('Unauthorized');
  }
};

// --- Routes --- //

app.get('/', (req, res) => {
  res.send('✅ Shopify Tracking Backend is live');
});

app.post('/webhooks/fulfillments/create', verifyShopifyWebhook, async (req, res) => {
  try {
    const fulfillment = req.body;
    console.log('📦 Fulfillment received:', fulfillment.name);

    const orderName = fulfillment.name;
    const trackingUrl = fulfillment.tracking_url;

    if (orderName && trackingUrl) {
      await db.collection('orders').add({
        orderNumber: orderName,
        trackingUrl: trackingUrl,
        createdAt: new Date()
      });
      console.log(`✅ Stored tracking for ${orderName}`);
    }

    res.status(200).send();
  } catch (err) {
    console.error('🔥 Error handling fulfillment webhook:', err);
    res.status(200).send(); // Respond 200 so Shopify doesn’t retry
  }
});

app.get('/get-tracking-url', async (req, res) => {
  const orderNumberQuery = req.query.orderNumber;

  if (!orderNumberQuery) {
    return res.status(400).json({ error: 'Order number is required.' });
  }

  try {
    const withHash = orderNumberQuery.startsWith('#') ? orderNumberQuery : `#${orderNumberQuery}`;
    const withoutHash = orderNumberQuery.startsWith('#') ? orderNumberQuery.substring(1) : orderNumberQuery;

    const snapshot = await db.collection('orders')
      .where('orderNumber', 'in', [withHash, withoutHash])
      .limit(1)
      .get();

    if (snapshot.empty) {
      console.log(`❓ Order not found: ${orderNumberQuery}`);
      return res.status(404).json({ error: 'Order not found.' });
    }

    const data = snapshot.docs[0].data();
    return res.status(200).json({ trackingUrl: data.trackingUrl });
  } catch (error) {
    console.error('🔥 Error fetching tracking:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
