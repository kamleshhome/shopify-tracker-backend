// --- Import necessary libraries ---
const express = require('express');
const crypto = require('crypto');
const admin = require('firebase-admin');
const cors = require('cors'); // Import the CORS library

// --- Initialize Express App ---
const app = express();

// --- IMPORTANT SECURITY: Use the CORS middleware ---
// This allows your frontend page to make requests to this server
app.use(cors());

// --- Firebase Configuration ---
// This is securely loaded from the Environment Variables on Render
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
// This is securely loaded from the Environment Variables on Render
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;

// --- Middleware to verify Shopify Webhooks ---
const verifyShopifyWebhook = (req, res, next) => {
    const hmac = req.get('X-Shopify-Hmac-Sha256');
    const body = req.rawBody; // We'll get the raw body before it's parsed
    const topic = req.get('X-Shopify-Topic');
    const shop = req.get('X-Shopify-Shop-Domain');

    if (!hmac || !body || !topic || !shop) {
        console.error('Webhook verification failed: Missing required headers.');
        return res.status(401).send('Unauthorized');
    }

    const genHash = crypto
        .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
        .update(body, 'utf8')
        .digest('base64');

    if (genHash === hmac) {
        req.body = JSON.parse(body.toString()); // Make parsed body available
        next();
    } else {
        console.error('Webhook verification failed: HMAC mismatch.');
        return res.status(401).send('Unauthorized');
    }
};

// --- Routes ---

// 1. Root Route: A simple welcome message to check if the server is running
app.get('/', (req, res) => {
  res.send('Shopify Tracking App Backend is running!');
});

// 2. Webhook Handler: Where Shopify sends fulfillment notifications
// We get the raw body for verification, then use express.json() for the actual logic
app.post('/webhooks/fulfillments/create', express.raw({ type: 'application/json' }), verifyShopifyWebhook, async (req, res) => {
    try {
        const fulfillment = req.body; // Body is already parsed by middleware
        console.log('Received and verified fulfillment webhook:', fulfillment.name);

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


// 3. NEW Route: Fetch Tracking URL for the customer-facing page
app.get('/get-tracking-url', async (req, res) => {
    const orderNumberQuery = req.query.orderNumber;
    
    if (!orderNumberQuery) {
        return res.status(400).json({ error: 'Order number is required.' });
    }

    try {
        // Create two versions of the order number to search for
        const withHash = orderNumberQuery.startsWith('#') ? orderNumberQuery : `#${orderNumberQuery}`;
        const withoutHash = orderNumberQuery.startsWith('#') ? orderNumberQuery.substring(1) : orderNumberQuery;

        // Query for either version
        const ordersRef = db.collection('orders');
        const snapshot = await ordersRef
            .where('orderNumber', 'in', [withHash, withoutHash])
            .limit(1)
            .get();

        if (snapshot.empty) {
            console.log(`Order not found for query: ${orderNumberQuery}`);
            return res.status(404).json({ error: 'Order not found.' });
        }

        const orderData = snapshot.docs[0].data();
        console.log(`Found tracking URL for: ${orderNumberQuery}`);
        return res.status(200).json({ trackingUrl: orderData.trackingUrl });

    } catch (error) {
        console.error('Error fetching tracking URL from Firestore:', error);
        return res.status(500).json({ error: 'An internal server error occurred.' });
    }
});

// --- Start the server ---
const port = process.env.PORT || 10000;
app.listen(port, () => {
  console.log(`Your app is listening on port ${port}`);
});

