
const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const admin = require("firebase-admin");
const stripePackage = require("stripe");
const fs = require("fs");
const path = require("path");

dotenv.config();

// ==========================================
// 1. ENVIRONMENT VARIABLES
// ==========================================

const PORT = process.env.PORT || 5000;

const STRIPE_KEY = process.env.STRIPE_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const FRONTEND_URL = (
  process.env.FRONTEND_URL ||
  "https://amazon-mfvz.vercel.app"
).replace(/\/+$/, "");

if (!STRIPE_KEY) {
  throw new Error("STRIPE_KEY is missing!");
}

if (!STRIPE_WEBHOOK_SECRET) {
  throw new Error("STRIPE_WEBHOOK_SECRET is missing!");
}

// ==========================================
// 2. STRIPE INITIALIZATION
// ==========================================

const stripe = stripePackage(STRIPE_KEY);

// ==========================================
// 3. FIREBASE ADMIN INITIALIZATION
// ==========================================

let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
  serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  );
} else {
  const serviceAccountPath = path.join(
    __dirname,
    "serviceAccountKey.json"
  );

  if (!fs.existsSync(serviceAccountPath)) {
    throw new Error(
      "Firebase service account file is missing!"
    );
  }

  serviceAccount = require(serviceAccountPath);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

// ==========================================
// 4. EXPRESS APP
// ==========================================

const app = express();

// ==========================================
// 5. CORS CONFIGURATION
// ==========================================

const allowedOrigins = [
  "http://localhost:5173",

  "https://amazon-clone-rho-umber.vercel.app",

  "https://amazon-71o06spta-yhawelet-3567s-projects.vercel.app",

  "https://amazon-mfvz.vercel.app",

  FRONTEND_URL,
].filter(Boolean);

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    console.log("CORS blocked origin:", origin);

    return callback(new Error("Not allowed by CORS"));
  },

  methods: [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
  ],

  allowedHeaders: [
    "Content-Type",
    "Authorization",
  ],

  credentials: false,
};

// CORS must come before API routes
app.use(cors(corsOptions));

// ==========================================
// 6. HEALTH CHECK
// ==========================================

app.get("/", (req, res) => {
  return res.status(200).json({
    message: "Amazon Render API is running successfully!",
  });
});

// ==========================================
// 7. STRIPE WEBHOOK
// IMPORTANT: Before express.json()
// ==========================================

app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (error) {
      console.error(
        "Webhook signature error:",
        error.message
      );

      return res.status(400).send(
        `Webhook Error: ${error.message}`
      );
    }

    try {
      if (
        event.type === "checkout.session.completed" ||
        event.type === "checkout.session.async_payment_succeeded"
      ) {
        const session = event.data.object;

        if (session.payment_status === "paid") {
          const userId = session.metadata?.userId;

          if (!userId) {
            console.error("Webhook userId is missing");

            return res.status(200).json({
              received: true,
            });
          }

          const orderRef = db
            .collection("orders")
            .doc(session.id);

          const orderSnapshot = await orderRef.get();

          if (!orderSnapshot.exists) {
            console.error(
              "Order not found:",
              session.id
            );

            return res.status(200).json({
              received: true,
            });
          }

          const existingData = orderSnapshot.data();

          const orderData = {
            ...existingData,
            paymentStatus: "paid",
            paymentIntent: session.payment_intent || null,
            amount: session.amount_total
              ? session.amount_total / 100
              : existingData.total,
            currency: session.currency || "usd",
            updatedAt:
              admin.firestore.FieldValue.serverTimestamp(),
          };

          // Update main orders collection
          await orderRef.set(orderData, {
            merge: true,
          });

          // Update user's orders collection
          await db
            .collection("users")
            .doc(userId)
            .collection("orders")
            .doc(session.id)
            .set(orderData, {
              merge: true,
            });

          console.log(
            "Order marked as paid:",
            session.id
          );
        }
      }

      return res.status(200).json({
        received: true,
      });

    } catch (error) {
      console.error(
        "Webhook processing error:",
        error
      );

      return res.status(500).json({
        error: "Webhook processing failed",
      });
    }
  }
);

// ==========================================
// 8. JSON MIDDLEWARE
// ==========================================

app.use(express.json());

// ==========================================
// 9. CREATE CHECKOUT SESSION
// ==========================================

app.post(
  "/create-checkout-session",
  async (req, res) => {
    try {
      const {
        basket,
        userId,
        userEmail,
        checkoutKey,
      } = req.body;

      // Validate user
      if (!userId) {
        return res.status(400).json({
          error: "User ID is required",
        });
      }

      // Validate checkout key
      if (
        !checkoutKey ||
        typeof checkoutKey !== "string"
      ) {
        return res.status(400).json({
          error: "Checkout key is required",
        });
      }

      // Validate basket
      if (
        !Array.isArray(basket) ||
        basket.length === 0
      ) {
        return res.status(400).json({
          error: "Your basket is empty",
        });
      }

      // Clean basket data
      const cleanBasket = basket.map((item) => {
        const price = Number(item.price);
        const amount = Number(item.amount || 1);

        if (
          !Number.isFinite(price) ||
          price <= 0 ||
          !Number.isInteger(amount) ||
          amount <= 0
        ) {
          throw new Error(
            "Invalid product price or quantity"
          );
        }

        return {
          id: item.id || "",
          title: item.title || "Amazon Product",
          price,
          thumbnail: item.thumbnail || "",
          amount,
          rating: item.rating || 0,
          description: item.description || "",
        };
      });

      // Calculate total on backend
      const total = cleanBasket.reduce(
        (sum, item) =>
          sum + item.price * item.amount,
        0
      );

      const amountInCents = Math.round(total * 100);

      if (amountInCents < 50) {
        return res.status(400).json({
          error: "Payment amount is too small",
        });
      }

      // ==================================
      // STRIPE CHECKOUT SESSION
      // ==================================

      const idempotencyKey =
        `amazon_checkout_${userId}_${checkoutKey.trim()}`;

      const session =
        await stripe.checkout.sessions.create(
          {
            ui_mode: "elements",

            mode: "payment",

            customer_email: userEmail || undefined,

            metadata: {
              userId,
              checkoutKey: checkoutKey.trim(),
            },

            line_items: [
              {
                price_data: {
                  currency: "usd",

                  product_data: {
                    name: "Amazon Order",
                  },

                  unit_amount: amountInCents,
                },

                quantity: 1,
              },
            ],

            return_url:
              `${FRONTEND_URL}/Orders?session_id={CHECKOUT_SESSION_ID}`,
          },
          {
            idempotencyKey,
          }
        );

      // ==================================
      // SAVE PENDING ORDER
      // ==================================

      const orderData = {
        userId,
        basket: cleanBasket,
        total,
        currency: "usd",
        paymentStatus: "pending",
        sessionId: session.id,
        paymentIntent: null,
        createdAt:
          admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:
          admin.firestore.FieldValue.serverTimestamp(),
      };

      const orderRef = db
        .collection("orders")
        .doc(session.id);

      await orderRef.set(orderData);

      // Save under user account
      await db
        .collection("users")
        .doc(userId)
        .collection("orders")
        .doc(session.id)
        .set(orderData);

      console.log(
        "Checkout session created:",
        session.id
      );

      return res.status(200).json({
        clientSecret: session.client_secret,
        sessionId: session.id,
      });

    } catch (error) {
      console.error(
        "Checkout session error:",
        error
      );

      return res.status(500).json({
        error:
          error.message ||
          "Unable to create checkout session",
      });
    }
  }
);

// ==========================================
// 10. ERROR HANDLER
// ==========================================

app.use((error, req, res, next) => {
  console.error("Server error:", error.message);

  if (error.message === "Not allowed by CORS") {
    return res.status(403).json({
      error: "Origin not allowed by CORS",
    });
  }

  return res.status(500).json({
    error: "Internal server error",
  });
});

// ==========================================
// 11. START SERVER
// ==========================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `Amazon API running on port ${PORT}`
  );

  console.log(
    "Allowed frontend:",
    allowedOrigins
  );
});
