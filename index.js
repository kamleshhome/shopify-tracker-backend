const express = require('express');
const crypto = require('crypto');
const admin = require('firebase-admin');
const cors = require('cors');

const app = express();

// Capture raw body for HMAC
app.use(express.raw({
  type: 'application/json',
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

app.use(cors());

// Firebase
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');
if (serviceAccount.project_id) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  console.log('✅ Firebase Admin SDK initialized.');
} else {
  console.error('❌ FIREBASE_SERVICE_ACCOUNT not set.');
}
const db = admin.firestore();

// Secrets
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

// Helpers
const normalizeOrderNumber = (raw = '') =>
  raw.toString()
     .replace(/^#?/, '')     // remove leading '#'
     .replace(/\.\d+$/, ''); // remove '.1', '.2', etc.

const pickTrackingUrl = (f = {}) =>
  (Array.isArray(f.tracking_urls) && f.tracking_urls[0]) ||
  f.tracking_url ||
  null;

// HMAC verification
const verifyShopifyWebhook = (req, res, next) => {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const topic = req.get('X-Shopify-Topic');
  const shop  = req.get('X-Shopify-Shop-Domain');

  if (!hmac || !req.rawBody || !topic || !shop) {
    console.error('❌ Missing required headers.');
    return res.status(401).send('Unauthorized');
  }

  const gen = crypto.createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
                    .update(req.rawBody)
                    .digest('base64');

  if (gen !== hmac) {
    console.error('❌ HMAC mismatch.');
    return res.status(401).send('Unauthorized');
  }

  try {
    req.body = JSON.parse(req.rawBody.toString('utf8'));
    next();
  } catch {
    console.error('❌ Invalid JSON body.');
    return res.status(400).send('Bad Request');
  }
};

// Root
app.get('/', (_req, res) => res.send('✅ Shopify Tracking Backend is live'));

// Shared handler
const handleFulfillment = async (req, res, source) => {
  try {
    const f = req.body;
    const rawName = f?.name || '';
    const base = normalizeOrderNumber(rawName);
    const display = `#${base}`;
    const trackingUrl = pickTrackingUrl(f);

    console.log(`📦 ${source} received:`, rawName);

    if (base && trackingUrl) {
      // Upsert by doc id = base order number
      const docRef = db.collection('orders').doc(base);
      await docRef.set({
        orderNumberBase: base,
        orderNumber: display,
        trackingUrl,
        updatedAt: new Date()
      }, { merge: true });

      // Optional: append to history subcollection
      await docRef.collection('history').add({ trackingUrl, at: new Date(), source });

      console.log(`✅ Stored tracking for ${rawName} → ${trackingUrl}`);
    } else {
      console.log(`ℹ️ Missing data. base:${base} tracking:${trackingUrl}`);
    }

    res.status(200).send();
  } catch (err) {
    console.error('🔥 Error handling fulfillment:', err);
    // still 200 to avoid retries storm
    res.status(200).send();
  }
};

// Webhooks
app.post('/webhooks/fulfillments/create', verifyShopifyWebhook, (req, res) =>
  handleFulfillment(req, res, 'FULFILLMENTS_CREATE')
);

app.post('/webhooks/fulfillments/update', verifyShopifyWebhook, (req, res) =>
  handleFulfillment(req, res, 'FULFILLMENTS_UPDATE')
);

// Public lookup
app.get('/get-tracking-url', async (req, res) => {
  const q = (req.query.orderNumber || '').toString().trim();
  if (!q) return res.status(400).json({ error: 'Order number is required.' });

  try {
    const base = normalizeOrderNumber(q); // works with or without '#', ignores '.1'
    const snap = await db.collection('orders').doc(base).get();

    if (!snap.exists) {
      console.log(`❓ Order not found: ${q}`);
      return res.status(404).json({ error: 'Order not found.' });
    }

    const data = snap.data();
    return res.status(200).json({ trackingUrl: data.trackingUrl });
  } catch (error) {
    console.error('🔥 Error fetching tracking:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Start
const port = process.env.PORT || 10000;
app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
