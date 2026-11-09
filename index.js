
const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const admin = require("firebase-admin");
const stripePackage = require("stripe");
const fs = require("fs");
const path = require("path");

dotenv.config();

// ==================================
// ENVIRONMENT VARIABLES
// ==================================

const PORT = process.env.PORT || 5000;
const STRIPE_KEY = process.env.STRIPE_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const FRONTEND_URL = (
  process.env.FRONTEND_URL || "http://localhost:5173"
).replace(/\/+$/, "");

if (!STRIPE_KEY) {
  throw new Error("STRIPE_KEY is missing from environment variables");
}

if (!STRIPE_WEBHOOK_SECRET) {
  throw new Error(
    "STRIPE_WEBHOOK_SECRET is missing from environment variables"
  );
}

// ==================================
// STRIPE
// ==================================

const stripe = stripePackage(STRIPE_KEY);

// ==================================
// FIREBASE ADMIN
// ==================================

const serviceAccountPath = path.join(
  __dirname,
  "serviceAccountKey.json"
);

let serviceAccount;

try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(
      process.env.FIREBASE_SERVICE_ACCOUNT_JSON
    );
  } else if (fs.existsSync(serviceAccountPath)) {
    serviceAccount = JSON.parse(
      fs.readFileSync(serviceAccountPath, "utf8")
    );
  } else {
    throw new Error("Firebase service account credentials not found");
  }
} catch (error) {
  console.error("Firebase credentials error:", error.message);
  throw error;
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

// ==================================
// EXPRESS APP
// ==================================

const app = express();

const allowedOrigins = [
  "http://localhost:5173",
  FRONTEND_URL
].filter(Boolean);

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      return callback(new Error("Not allowed by CORS"));
    }
  })
);

// ==================================
// HOME ROUTE
// ==================================

app.get("/", (req, res) => {
  res.status(200).json({
    message: "Amazon Render API is running successfully!"
  });
});

// ==================================
// STRIPE WEBHOOK
// IMPORTANT: MUST BE BEFORE express.json()
// ==================================

app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];

    let event;

    try {
      if (!signature) {
        return res.status(400).send("Missing Stripe signature");
      }

      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (error) {
      console.error("Webhook signature error:", error.message);
      return res.status(400).send("Invalid webhook signature");
    }

    try {
      if (
        event.type === "checkout.session.completed" ||
        event.type === "checkout.session.async_payment_succeeded"
      ) {
        const session = event.data.object;

        if (session.payment_status !== "paid") {
          return res.status(200).json({
            received: true,
            message: "Payment is not paid yet"
          });
        }

        const userId = session.metadata?.userId || null;

        const orderRef = db
          .collection("orders")
          .doc(session.id);

        const existingSnapshot = await orderRef.get();

        const existingData = existingSnapshot.exists
          ? existingSnapshot.data()
          : {};

        const order = {
          orderId: session.id,
          userId,

          userEmail:
            session.customer_details?.email ||
            session.customer_email ||
            existingData.userEmail ||
            null,

          basket: existingData.basket || [],

          total: (session.amount_total || 0) / 100,
          amount: (session.amount_total || 0) / 100,

          currency: session.currency || "usd",
          paymentStatus: "paid",

          paymentIntent:
            typeof session.payment_intent === "string"
              ? session.payment_intent
              : session.payment_intent?.id || null,

          createdAt:
            existingData.createdAt ||
            FieldValue.serverTimestamp(),

          created:
            existingData.created ||
            FieldValue.serverTimestamp()
        };

        await orderRef.set(order, { merge: true });

        if (userId) {
          await db
            .collection("users")
            .doc(userId)
            .collection("orders")
            .doc(session.id)
            .set(order, { merge: true });
        }

        console.log("Order payment completed:", session.id);
      }

      return res.status(200).json({
        received: true
      });

    } catch (error) {
      console.error("Webhook processing error:", error);

      return res.status(500).send("Webhook processing failed");
    }
  }
);

// ==================================
// JSON BODY PARSER
// ==================================

app.use(express.json());

// ==================================
// CREATE CHECKOUT SESSION
// ==================================

app.post("/create-checkout-session", async (req, res) => {
  try {
    const {
      basket,
      userId,
      userEmail,
      checkoutKey
    } = req.body;

    // Validate user
    if (!userId || !userEmail) {
      return res.status(400).json({
        error: "User information is required"
      });
    }

    // Validate checkout key
    if (
      !checkoutKey ||
      typeof checkoutKey !== "string" ||
      !checkoutKey.trim()
    ) {
      return res.status(400).json({
        error: "Checkout key is required"
      });
    }

    // Validate basket
    if (!Array.isArray(basket) || basket.length === 0) {
      return res.status(400).json({
        error: "Your basket is empty"
      });
    }

    // Prepare basket products
    const orderBasket = basket.map((item) => {
      const price = Number(item.price);
      const amount = Number(item.amount) || 1;

      if (
        !item.id ||
        !item.title ||
        !Number.isFinite(price) ||
        price <= 0 ||
        !Number.isFinite(amount) ||
        amount <= 0
      ) {
        throw new Error("Invalid product information in basket");
      }

      return {
        id: String(item.id),
        title: String(item.title),
        price,
        thumbnail: String(item.thumbnail || ""),
        amount,
        rating: Number(item.rating) || 0,
        description: String(item.description || "")
      };
    });

    // Calculate total
    const total = orderBasket.reduce(
      (sum, item) => sum + item.price * item.amount,
      0
    );

    if (!Number.isFinite(total) || total <= 0) {
      return res.status(400).json({
        error: "Invalid order total"
      });
    }

    const amountInCents = Math.round(total * 100);

    // Stripe idempotency key
    const idempotencyKey =
      `amazon_checkout_${userId}_${checkoutKey.trim()}`;

    // Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create(
      {
        ui_mode: "elements",
        mode: "payment",

        // Email is set here.
        // Do not also pass email in Stripe confirm().

        customer_email: userEmail,

        metadata: {
          userId: String(userId),
          checkoutKey: checkoutKey.trim()
        },

        line_items: [
          {
            price_data: {
              currency: "usd",

              product_data: {
                name: "Amazon Order"
              },

              unit_amount: amountInCents
            },

            quantity: 1
          }
        ],

        return_url:
          `${FRONTEND_URL}/Orders?session_id={CHECKOUT_SESSION_ID}`
      },
      {
        idempotencyKey
      }
    );

    // ==================================
    // SAVE PENDING ORDER TO FIRESTORE
    // ==================================

    const orderRef = db
      .collection("orders")
      .doc(session.id);

    const pendingOrder = {
      orderId: session.id,
      userId: String(userId),
      userEmail,

      basket: orderBasket,

      total,
      amount: total,

      currency: "usd",
      paymentStatus: "pending",

      createdAt: FieldValue.serverTimestamp(),
      created: FieldValue.serverTimestamp()
    };

    await db.runTransaction(async (transaction) => {
      const existing = await transaction.get(orderRef);

      if (!existing.exists) {
        transaction.set(orderRef, pendingOrder);
      }
    });

    // Save order under user's account
    const savedOrderSnapshot = await orderRef.get();
    const savedOrder = savedOrderSnapshot.data();

    if (savedOrder) {
      await db
        .collection("users")
        .doc(String(userId))
        .collection("orders")
        .doc(session.id)
        .set(savedOrder, { merge: true });
    }

    console.log("Checkout Session:", session.id);
    console.log("Order saved:", session.id);

    return res.status(200).json({
      clientSecret: session.client_secret,
      sessionId: session.id
    });

  } catch (error) {
    console.error("Stripe Checkout Error:", error);

    return res.status(500).json({
      error: error.message || "Unable to create checkout session"
    });
  }
});

// ==================================
// START SERVER
// ==================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Amazon API running on port ${PORT}`);
});
