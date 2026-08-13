require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const catalogPath = path.join(__dirname, "catalog.json");
const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));

/*
  Firebase

  We will add the Firebase service-account credentials
  privately through Render environment variables later.

  DO NOT put the Firebase private key in GitHub.
*/
let db = null;

function initFirebase() {
  if (db) return db;

  if (
    !process.env.FIREBASE_PROJECT_ID ||
    !process.env.FIREBASE_CLIENT_EMAIL ||
    !process.env.FIREBASE_PRIVATE_KEY
  ) {
    console.warn("Firebase environment variables are not configured yet.");
    return null;
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n")
      })
    });
  }

  db = admin.firestore();
  return db;
}

/*
  Health check
*/
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "STAYUNKNOWN Paystack Backend",
    paystackConfigured: Boolean(process.env.PAYSTACK_SECRET_KEY),
    firebaseConfigured: Boolean(
      process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_CLIENT_EMAIL &&
      process.env.FIREBASE_PRIVATE_KEY
    )
  });
});

/*
  Public catalogue endpoint.

  The browser may read the catalogue,
  but prices are still checked again on the server
  when an order is created.
*/
app.get("/api/catalog", (_req, res) => {
  res.json({
    products: catalog
  });
});

/*
  Find a product in the trusted server-side catalogue.
*/
function findProduct(productId) {
  return catalog.find(product => product.id === productId);
}

/*
  Build a trusted order from the customer's cart.

  The customer sends:
  productId, quantity, size and colour.

  The server decides the actual product name and price.
*/
function buildTrustedItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Cart is empty.");
  }

  return items.map(item => {
    const product = findProduct(item.productId);

    if (!product) {
      throw new Error(`Product not found: ${item.productId}`);
    }

    if (product.comingSoon) {
      throw new Error(`${product.name} is coming soon.`);
    }

    const quantity = Number(item.quantity);

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
      throw new Error(`Invalid quantity for ${product.name}.`);
    }

    const size = String(item.size || "").trim();
    const color = String(item.color || "").trim();

    if (!size || !color) {
      throw new Error(`Size and colour are required for ${product.name}.`);
    }

    if (!product.sizes.includes(size)) {
      throw new Error(`Invalid size for ${product.name}.`);
    }

    if (!product.colors.includes(color)) {
      throw new Error(`Invalid colour for ${product.name}.`);
    }

    return {
      productId: product.id,
      name: product.name,
      category: product.category,
      price: product.price,
      quantity,
      size,
      color,
      lineTotal: product.price * quantity
    };
  });
}

/*
  Paystack API helper.
*/
async function paystackRequest(endpoint, options = {}) {
  if (!process.env.PAYSTACK_SECRET_KEY) {
    throw new Error("Paystack secret key is not configured.");
  }

  const response = await fetch(`https://api.paystack.co${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const data = await response.json();

  if (!response.ok || !data.status) {
    throw new Error(
      data.message || "Paystack request failed."
    );
  }

  return data;
}

/*
  Initialize a Paystack transaction.

  IMPORTANT:
  The amount is calculated from catalog.json,
  NOT trusted from the browser.
*/
app.post("/api/paystack/initialize", async (req, res) => {
  try {
    const {
      email,
      phone = "",
      items,
      callbackUrl = ""
    } = req.body || {};

    const cleanEmail = String(email || "").trim().toLowerCase();

    if (!cleanEmail || !cleanEmail.includes("@")) {
      return res.status(400).json({
        error: "A valid email address is required."
      });
    }

    const trustedItems = buildTrustedItems(items);

    const total = trustedItems.reduce(
      (sum, item) => sum + item.lineTotal,
      0
    );

    const reference = `SU-${Date.now()}-${crypto
      .randomBytes(5)
      .toString("hex")
      .toUpperCase()}`;

    const metadata = {
      store: "STAYUNKNOWN",
      reference,
      email: cleanEmail,
      phone: String(phone || "").trim(),
      items: trustedItems.map(item => ({
        productId: item.productId,
        name: item.name,
        category: item.category,
        price: item.price,
        quantity: item.quantity,
        size: item.size,
        color: item.color
      }))
    };

    const result = await paystackRequest("/transaction/initialize", {
      method: "POST",
      body: JSON.stringify({
        email: cleanEmail,
        amount: total * 100,
        currency: "NGN",
        reference,
        callback_url: callbackUrl || undefined,
        metadata
      })
    });

    res.json({
      ok: true,
      reference,
      access_code: result.data.access_code,
      authorization_url: result.data.authorization_url,
      amount: total,
      currency: "NGN"
    });
  } catch (error) {
    console.error("Paystack initialization error:", error);

    res.status(400).json({
      error: error.message || "Unable to initialize payment."
    });
  }
});

/*
  Verify a Paystack transaction.

  This is the server-side source of truth for payment status.
*/
app.post("/api/paystack/verify", async (req, res) => {
  try {
    const reference = String(req.body?.reference || "").trim();

    if (!reference) {
      return res.status(400).json({
        error: "Payment reference is required."
      });
    }

    const result = await paystackRequest(
      `/transaction/verify/${encodeURIComponent(reference)}`
    );

    const transaction = result.data;

    const paid =
      transaction.status === "success" &&
      transaction.currency === "NGN";

    if (!paid) {
      return res.json({
        paid: false,
        status: transaction.status || "unknown"
      });
    }

    const order = await savePaidOrder(transaction);

    res.json({
      paid: true,
      order
    });
  } catch (error) {
    console.error("Payment verification error:", error);

    res.status(400).json({
      error: error.message || "Unable to verify payment."
    });
  }
});

/*
  Save a verified payment to Firestore.

  If Firebase is not configured yet, we still return
  the verified payment information so we can test Paystack
  before connecting the database.
*/
async function savePaidOrder(transaction) {
  const reference = transaction.reference;

  const metadata =
    typeof transaction.metadata === "string"
      ? JSON.parse(transaction.metadata || "{}")
      : transaction.metadata || {};

  const items = Array.isArray(metadata.items)
    ? metadata.items
    : [];

  const totalNaira = Number(transaction.amount) / 100;

  const order = {
    orderNumber: reference,
    paymentReference: reference,
    paymentStatus: "PAID",
    paymentChannel: transaction.channel || "",
    currency: transaction.currency || "NGN",

    customer: {
      email:
        transaction.customer?.email ||
        metadata.email ||
        "",
      phone:
        metadata.phone ||
        transaction.customer?.phone ||
        ""
    },

    items,

    total: totalNaira,

    paidAt:
      transaction.paid_at ||
      new Date().toISOString(),

    createdAt: new Date().toISOString()
  };

  const firestore = initFirebase();

  if (firestore) {
    const existing = await firestore
      .collection("orders")
      .where("paymentReference", "==", reference)
      .limit(1)
      .get();

    if (!existing.empty) {
      return {
        id: existing.docs[0].id,
        ...existing.docs[0].data()
      };
    }

    const doc = await firestore
      .collection("orders")
      .add(order);

    return {
      id: doc.id,
      ...order
    };
  }

  return {
    id: reference,
    ...order
  };
}

/*
  Paystack webhook.

  Paystack signs webhook requests with HMAC SHA-512.
*/
app.post(
  "/api/paystack/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const signature = req.headers["x-paystack-signature"];

      if (!signature || !process.env.PAYSTACK_SECRET_KEY) {
        return res.status(401).send("Invalid signature");
      }

      const expected = crypto
        .createHmac(
          "sha512",
          process.env.PAYSTACK_SECRET_KEY
        )
        .update(req.body)
        .digest("hex");

      const signatureBuffer = Buffer.from(String(signature));
      const expectedBuffer = Buffer.from(expected);

      if (
        signatureBuffer.length !== expectedBuffer.length ||
        !crypto.timingSafeEqual(
          signatureBuffer,
          expectedBuffer
        )
      ) {
        return res.status(401).send("Invalid signature");
      }

      const event = JSON.parse(req.body.toString("utf8"));

      if (event.event === "charge.success") {
        await savePaidOrder(event.data);
      }

      res.sendStatus(200);
    } catch (error) {
      console.error("Paystack webhook error:", error);
      res.sendStatus(500);
    }
  }
);

/*
  Start server.
*/
app.listen(PORT, () => {
  console.log(
    `STAYUNKNOWN backend running on port ${PORT}`
  );
});
