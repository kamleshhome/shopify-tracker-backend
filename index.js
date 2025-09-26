// --- Import necessary libraries ---
const express = require('express');
const crypto = require('crypto');
const admin = require('firebase-admin');
const cors = require('cors');

// --- Initialize Express App ---
const app = express();
app.use(cors()); // Allow CORS for frontend

// --- Firebase Configuration ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');

if (serviceAccount.project_id) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log('🔥 Firebase Admin SDK initialized successfully.');
} else {
    console.error('❌ FIREBASE_SERVICE_ACCOUNT environment variable is not set correctly.');
}

const db = admin.firestore();

// --- Shopify Configuration ---
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

// --- Middleware: Parse raw body for Shopify HMAC ---
app.use('/webhooks/fulfillments/create', express.raw({ type: 'application/json' }));

// --- Middleware to verify Shopify HMAC ---
const verifyShopifyWebhook = (req, res, next) => {
    const hmac = req.get('X-Shopify-Hmac-Sha256');
    const topic = req.get('X-Shopify-Topic');
    const shop = req.get('X-Shopify-Shop-Domain');

    if (!hmac || !req.body || !topic || !shop) {
        console.error('❌ Webhook verification failed: Missing required headers.');
        return res.status(401).send('Unauthorized');
    }

    const generatedHash = crypto
        .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
        .update(req.body)
        .digest('base64');

    if (generatedHash !== hmac) {
        console.error('❌ Webhook verification failed: HMAC mismatch.');
        return res.status(401).send('Unauthorized');
    }

    try {
        req.body = JSON.parse(req.body.toString('utf8')); // Safe parse
        next();
    } catch (err) {
        console.error('❌ Invalid JSON in webhook payload.');
        return res.status(400).send('Bad Request');
    }
};

// --- Root Route ---
app.get('/', (req, res) => {
    res.send('✅ Shopify Tracking App Backend is running!');
});

// --- Webhook: Fulfillment Creation ---
app.post('/webhooks/fulfillments/create', verifyShopifyWebhook, async (req, res) => {
    try {
        const fulfillment = req.body;
        console.log('📦 Received fulfillment webhook for:', fulfillment.name);

        const orderName = fulfillment.name;
        const trackingUrl = fulfillment.tracking_url;

        if (orderName && trackingUrl) {
            await db.collection('orders').add({
                orderNumber: orderName,
                trackingUrl: trackingUrl,
                createdAt: new Date()
            });
            console.log(`✅ Stored tracking URL for order: ${orderName}`);
        }

        res.status(200).send();
    } catch (err) {
        console.error('❌ Error handling webhook:', err);
        res.status(200).send(); // Still return 200 to avoid retry spam
    }
});

// --- Public Route: Get Tracking URL by Order ID ---
app.get('/get-tracking-url', async (req, res) => {
    const orderNumberQuery = req.query.orderNumber;

    if (!orderNumberQuery) {
        return res.status(400).json({ error: 'Order number is required.' });
    }

    try {
        const withHash = orderNumberQuery.startsWith('#') ? orderNumberQuery : `#${orderNumberQuery}`;
        const withoutHash = orderNumberQuery.startsWith('#') ? orderNumberQuery.slice(1) : orderNumberQuery;

        const snapshot = await db.collection('orders')
            .where('orderNumber', 'in', [withHash, withoutHash])
            .limit(1)
            .get();

        if (snapshot.empty) {
            console.log(`❓ Order not found for: ${orderNumberQuery}`);
            return res.status(404).json({ error: 'Order not found.' });
        }

        const orderData = snapshot.docs[0].data();
        console.log(`🔗 Found tracking URL for: ${orderNumberQuery}`);
        return res.status(200).json({ trackingUrl: orderData.trackingUrl });

    } catch (err) {
        console.error('🔥 Error fetching from Firestore:', err);
        return res.status(500).json({ error: 'Internal server error.' });
    }
});

// --- Start Server ---
const port = process.env.PORT || 10000;
app.listen(port, () => {
    console.log(`🚀 App running on port ${port}`);
});
