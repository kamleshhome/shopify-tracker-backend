// --- Import necessary libraries ---
const express = require('express');
const crypto = require('crypto');
const admin = require('firebase-admin');
const cors = require('cors'); // Import the CORS library

// --- Initialize Express App ---
const app = express();

// --- IMPORTANT SECURITY: Use the CORS middleware ---
app.use(cors());

// --- Firebase Configuration ---
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');

if (serviceAccount.project_id) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
    console.log('Firebase Admin SDK initialized successfully.');
} else {
    console.error('FIREBASE_SERVICE_ACCOUNT environment variable is not set correctly.');
}

const db = admin.firestore();

// --- Shopify App Configuration ---
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

// --- Middleware to verify Shopify Webhooks ---
const verifyShopifyWebhook = (req, res, next) => {
    const hmac = req.get('X-Shopify-Hmac-Sha256');
    const topic = req.get('X-Shopify-Topic');
    const shop = req.get('X-Shopify-Shop-Domain');

    if (!hmac || !req.body || !topic || !shop) {
        console.error('Webhook verification failed: Missing required headers.');
        return res.status(401).send('Unauthorized');
    }

    const generatedHash = crypto
        .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
        .update(req.body)
        .digest('base64');

    if (generatedHash === hmac) {
        try {
            req.body = JSON.parse(req.body.toString()); // Parse raw body
            next();
        } catch (err) {
            console.error('Webhook verification failed: Invalid JSON body.');
            return res.status(400).send('Bad Request');
        }
    } else {
        console.error('Webhook verification failed: HMAC mismatch.');
        return res.status(401).send('Unauthorized');
    }
};

// --- Routes ---

// 1. Root Route
app.get('/', (req, res) => {
    res.send('Shopify Tracking App Backend is running!');
});

// 2. Fulfillment Webhook Handler
app.post(
    '/webhooks/fulfillments/create',
    express.raw({ type: 'application/json' }), // 🔧 required for HMAC verification
    verifyShopifyWebhook,
    async (req, res) => {
        try {
            const fulfillment = req.body;
            console.log('Received and verified fulfillment webhook:', fulfillment.name);

            const orderName = fulfillment.name;
            const trackingUrl = fulfillment.tracking_url;

            if (orderName && trackingUrl) {
                await db.collection('orders').add({
                    orderNumber: orderName,
                    trackingUrl: trackingUrl,
                    createdAt: new Date()
                });
                console.log(`✅ Successfully added tracking for order: ${orderName}`);
            }

            res.status(200).send();
        } catch (error) {
            console.error('❌ Error processing webhook:', error);
            res.status(200).send(); // Respond 200 to prevent retries
        }
    }
);

// 3. Tracking URL Lookup Endpoint
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
            console.log(`❓ Order not found for query: ${orderNumberQuery}`);
            return res.status(404).json({ error: 'Order not found.' });
        }

        const orderData = snapshot.docs[0].data();
        console.log(`🔗 Found tracking URL for: ${orderNumberQuery}`);
        return res.status(200).json({ trackingUrl: orderData.trackingUrl });

    } catch (error) {
        console.error('🔥 Error fetching tracking URL from Firestore:', error);
        return res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

// --- Start Server ---
const port = process.env.PORT || 10000;
app.listen(port, () => {
    console.log(`🚀 App is listening on port ${port}`);
});
