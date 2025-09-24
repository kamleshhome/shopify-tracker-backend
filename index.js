// --- Import necessary libraries ---
// Express is a framework that makes it easy to create a web server
const express = require('express');
// Node-fetch allows our server to make HTTP requests to other servers (like Shopify)
const fetch = require('node-fetch');
// The Firebase Admin SDK is used for secure server-to-server communication with Firebase
const admin = require('firebase-admin');

// --- Initialize Express App ---
const app = express();
// This is a middleware that allows our app to understand incoming JSON data from Shopify's webhooks
app.use(express.json());

// --- Firebase Configuration ---
// The service account key is securely stored as an environment variable on the server
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
console.log('Firebase Admin SDK initialized successfully.');

// --- Shopify App Configuration ---
// These values are securely stored as environment variables on the server
const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY;
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
// The scopes are the permissions your app is requesting from the merchant
const SCOPES = 'read_fulfillments';

// --- Routes ---

// 1. Root Route: A simple welcome message to check if the server is running
app.get('/', (req, res) => {
  res.send('Shopify Tracking App Backend is running!');
});

// 2. Install Route: This is where the installation process begins
app.get('/install', (req, res) => {
  const shop = req.query.shop;
  if (shop) {
    const installUrl = `https://{shop}.myshopify.com/admin/oauth/authorize?client_id=${SHOPIFY_API_KEY}&scope=${SCOPES}&redirect_uri=https://${req.hostname}/auth/callback`;
    res.redirect(installUrl.replace('{shop}', shop));
  } else {
    return res.status(400).send('Missing shop parameter. Please add ?shop=your-shop-name.myshopify.com to your request');
  }
});

// 3. Auth Callback Route: Where Shopify sends the merchant after they approve the installation
app.get('/auth/callback', async (req, res) => {
  const { shop, code } = req.query;

  if (!shop || !code) {
    return res.status(400).send('Required parameters missing.');
  }

  const accessTokenRequestUrl = `https://{shop}/admin/oauth/access_token`;
  const payload = {
    client_id: SHOPIFY_API_KEY,
    client_secret: SHOPIFY_API_SECRET,
    code,
  };

  try {
    const response = await fetch(accessTokenRequestUrl.replace('{shop}', shop), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    const accessToken = data.access_token;

    if (!accessToken) {
        return res.status(500).send('Could not get access token.');
    }

    const webhookUrl = `https://{shop}/admin/api/2023-10/webhooks.json`;
    const webhookPayload = {
      webhook: {
        topic: 'fulfillments/create',
        address: `https://${req.hostname}/webhooks/fulfillments/create`,
        format: 'json'
      }
    };

    await fetch(webhookUrl.replace('{shop}', shop), {
        method: 'POST',
        headers: {
            'X-Shopify-Access-Token': accessToken,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(webhookPayload)
    });

    console.log(`Webhook created for ${shop}`);
    res.send('App installed and webhook created successfully!');

  } catch (error) {
    console.error('Error during auth callback:', error);
    res.status(500).send('An error occurred.');
  }
});

// 4. Webhook Handler: Where Shopify sends fulfillment notifications
app.post('/webhooks/fulfillments/create', express.text({ type: '*/*' }), async (req, res) => {
    try {
        const fulfillment = JSON.parse(req.body);
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

// 5. NEW Route: Fetch Tracking URL for the customer-facing page
app.get('/get-tracking-url', async (req, res) => {
  const { orderNumber } = req.query;

  if (!orderNumber) {
    return res.status(400).json({ error: 'Order number is required.' });
  }

  try {
    const ordersRef = db.collection('orders');
    const snapshot = await ordersRef.where('orderNumber', '==', orderNumber).limit(1).get();

    if (snapshot.empty) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    const orderData = snapshot.docs[0].data();
    res.status(200).json({ trackingUrl: orderData.trackingUrl });

  } catch (error) {
    console.error('Error fetching tracking URL:', error);
    res.status(500).json({ error: 'An internal server error occurred.' });
  }
});


// --- Start the server ---
const listener = app.listen(process.env.PORT || 3000, () => {
  console.log('Your app is listening on port ' + listener.address().port);
});

