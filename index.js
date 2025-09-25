// --- Import necessary libraries ---
const express = require('express');
const admin = require('firebase-admin');
const cors = require('cors');
const crypto = require('crypto'); // Built-in Node.js library for security

// --- Initialize Express App ---
const app = express();
app.use(cors());

// --- Firebase Configuration ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
console.log('Firebase Admin SDK initialized successfully.');

// --- Shopify Credentials (from your Private App) ---
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

// --- Middleware to verify Shopify Webhooks ---
// This is a security step to ensure the data is really from Shopify
const verifyShopifyWebhook = (req, res, next) => {
    const hmac = req.get('X-Shopify-Hmac-Sha256');
    const body = req.rawBody;
    const hash = crypto.createHmac('sha256', SHOPIFY_WEBHOOK_SECRET).update(body, 'utf8', 'hex').digest('base64');
    if (hash === hmac) {
        next();
    } else {
        console.error('Webhook verification failed.');
        res.status(401).send('Unauthorized');
    }
};

// --- Routes ---

// 1. Root Route
app.get('/', (req, res) => {
  res.send('Casekaro Tracking Backend is running!');
});

// 2. Webhook Handler: Where Shopify sends fulfillment notifications
// We use a special middleware to get the raw body for verification
app.post('/webhooks/fulfillments/create', express.json({
    verify: (req, res, buf) => { req.rawBody = buf; }
}), verifyShopifyWebhook, async (req, res) => {
    try {
        const fulfillment = req.body;
        console.log('Received fulfillment webhook:', fulfillment);
        const orderName = fulfillment.name; 
        const trackingUrl = fulfillment.tracking_url;

        if (orderName && trackingUrl) {
            await db.collection('orders').add({
                orderNumber: orderName,
                trackingUrl: trackingUrl,
                createdAt: new Date()
            });
            console.log(`Successfully added tracking for order: ${orderName}`);
        }
        res.status(200).send();
    } catch (error) {
        console.error('Error processing webhook:', error);
        res.status(200).send();
    }
});

// 3. Fetch Tracking URL Route (for customers)
app.get('/get-tracking-url', async (req, res) => {
  // ... (This code remains exactly the same as the previous version)
  const { orderNumber: rawOrderNumber } = req.query;
  if (!rawOrderNumber) return res.status(400).json({ error: 'Order number is required.' });
  const searchTerms = rawOrderNumber.startsWith('#') ? [rawOrderNumber, rawOrderNumber.substring(1)] : [rawOrderNumber, '#' + rawOrderNumber];
  try {
    const snapshot = await db.collection('orders').where('orderNumber', 'in', searchTerms).limit(1).get();
    if (snapshot.empty) return res.status(404).json({ error: 'Order not found.' });
    res.status(200).json({ trackingUrl: snapshot.docs[0].data().trackingUrl });
  } catch (error) {
    console.error('Error fetching tracking URL:', error);
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});

// --- Start the server ---
const listener = app.listen(process.env.PORT || 3000, () => {
  console.log('Your app is listening on port ' + listener.address().port);
});

