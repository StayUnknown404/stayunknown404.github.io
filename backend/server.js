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

/*
  Paystack webhook needs the original raw request body
  so its HMAC signature can be verified.
*/
app.use((req, res, next) => {
  if (req.path === "/api/paystack/webhook") {
    return next();
  }

  return express.json()(req, res, next);
});

/*
  Trusted server-side product catalogue.
*/
const catalogPath = path.join(__dirname, "catalog.json");
const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8"));

/*
  Firebase Admin
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
  Firebase authentication middleware.

  The frontend must send:

  Authorization: Bearer <Firebase ID token>
*/
async function requireFirebaseUser(req, res, next) {
  try {
    const authorization = String(
      req.headers.authorization || ""
    );

    if (!authorization.startsWith("Bearer ")) {
      return res.status(401).json({
        error: "Authentication required."
      });
    }

    const token = authorization.slice("Bearer ".length).trim();

    if (!token) {
      return res.status(401).json({
        error: "Authentication token is missing."
      });
    }

    const firebase = initFirebase();

    if (!firebase) {
      return res.status(503).json({
        error: "Firebase is not configured on the server."
      });
    }

    const decoded = await admin.auth().verifyIdToken(token);

    req.firebaseUser = decoded;

    next();
  } catch (error) {
    console.error("Firebase authentication error:", error);

    return res.status(401).json({
      error: "Invalid or expired authentication token."
    });
  }
}

/*
  Health check
*/
app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "STAYUNKNOWN Paystack Backend",

    paystackConfigured: Boolean(
      process.env.PAYSTACK_SECRET_KEY
    ),

    firebaseConfigured: Boolean(
      process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_CLIENT_EMAIL &&
      process.env.FIREBASE_PRIVATE_KEY
    )
  });
});

/*
  Public catalogue endpoint.
*/
app.get("/api/catalog", (_req, res) => {
  res.json({
    products: catalog
  });
});

/*
  Find product in trusted server-side catalogue.
*/
function findProduct(productId) {
  return catalog.find(product => product.id === productId);
}

/*
  Build trusted cart items.
*/
function buildTrustedItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Cart is empty.");
  }

  return items.map(item => {
    const product = findProduct(item.productId);

    if (!product) {
      throw new Error(
        `Product not found: ${item.productId}`
      );
    }

    if (product.comingSoon) {
      throw new Error(
        `${product.name} is coming soon.`
      );
    }

    const quantity = Number(item.quantity);

    if (
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 20
    ) {
      throw new Error(
        `Invalid quantity for ${product.name}.`
      );
    }

    const size = String(
      item.size || ""
    ).trim();

    const color = String(
      item.color || ""
    ).trim();

    if (!size || !color) {
      throw new Error(
        `Size and colour are required for ${product.name}.`
      );
    }

    if (!product.sizes.includes(size)) {
      throw new Error(
        `Invalid size for ${product.name}.`
      );
    }

    if (!product.colors.includes(color)) {
      throw new Error(
        `Invalid colour for ${product.name}.`
      );
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
async function paystackRequest(
  endpoint,
  options = {}
) {
  if (!process.env.PAYSTACK_SECRET_KEY) {
    throw new Error(
      "Paystack secret key is not configured."
    );
  }

  const response = await fetch(
    `https://api.paystack.co${endpoint}`,
    {
      ...options,

      headers: {
        Authorization:
          `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,

        "Content-Type":
          "application/json",

        ...(options.headers || {})
      }
    }
  );

  const data = await response.json();

  if (!response.ok || !data.status) {
    throw new Error(
      data.message ||
      "Paystack request failed."
    );
  }

  return data;
}

/*
  Create a pending order.

  This happens BEFORE sending the customer
  to Paystack.

  If Firebase is configured, the order is saved.
*/
async function createPendingOrder({
  reference,
  email,
  phone,
  uid,
  items,
  total
}) {
  const firestore = initFirebase();

  if (!firestore) {
    return null;
  }

  const order = {
    orderNumber: reference,

    paymentReference: reference,

    paymentStatus: "PENDING",

    paymentChannel: "",

    currency: "NGN",

    customer: {
      uid: uid || "",
      email: email || "",
      phone: phone || ""
    },

    items,

    total,

    createdAt:
      new Date().toISOString(),

    updatedAt:
      new Date().toISOString()
  };

  const doc = await firestore
    .collection("orders")
    .add(order);

  return {
    id: doc.id,
    ...order
  };
}

/*
  Initialize Paystack transaction.
*/
app.post(
  "/api/paystack/initialize",
  async (req, res) => {
    try {
      const {
        email,
        phone = "",
        items,
        callbackUrl = "",
        userId = ""
      } = req.body || {};

      const cleanEmail =
        String(email || "")
          .trim()
          .toLowerCase();

      if (
        !cleanEmail ||
        !cleanEmail.includes("@")
      ) {
        return res.status(400).json({
          error:
            "A valid email address is required."
        });
      }

      const trustedItems =
        buildTrustedItems(items);

      const total =
        trustedItems.reduce(
          (sum, item) =>
            sum + item.lineTotal,
          0
        );

      const reference =
        `SU-${Date.now()}-${crypto
          .randomBytes(5)
          .toString("hex")
          .toUpperCase()}`;

      const cleanPhone =
        String(phone || "").trim();

      const cleanUserId =
        String(userId || "").trim();

      const metadata = {
        store: "STAYUNKNOWN",

        reference,

        email: cleanEmail,

        phone: cleanPhone,

        userId: cleanUserId,

        items:
          trustedItems.map(item => ({
            productId: item.productId,
            name: item.name,
            category: item.category,
            price: item.price,
            quantity: item.quantity,
            size: item.size,
            color: item.color
          }))
      };

      /*
        Save PENDING order before Paystack.
      */
      await createPendingOrder({
        reference,
        email: cleanEmail,
        phone: cleanPhone,
        uid: cleanUserId,
        items: trustedItems,
        total
      });

      const result =
        await paystackRequest(
          "/transaction/initialize",
          {
            method: "POST",

            body: JSON.stringify({
              email: cleanEmail,

              amount:
                total * 100,

              currency: "NGN",

              reference,

              callback_url:
                callbackUrl ||
                undefined,

              metadata
            })
          }
        );

      res.json({
        ok: true,

        reference,

        access_code:
          result.data.access_code,

        authorization_url:
          result.data.authorization_url,

        amount: total,

        currency: "NGN"
      });
    } catch (error) {
      console.error(
        "Paystack initialization error:",
        error
      );

      res.status(400).json({
        error:
          error.message ||
          "Unable to initialize payment."
      });
    }
  }
);

/*
  Update an existing order's payment status.
*/
async function updateOrderStatus(
  reference,
  status,
  transaction = null
) {
  const firestore = initFirebase();

  if (!firestore) {
    return null;
  }

  const snapshot =
    await firestore
      .collection("orders")
      .where(
        "paymentReference",
        "==",
        reference
      )
      .limit(1)
      .get();

  if (snapshot.empty) {
    return null;
  }

  const doc =
    snapshot.docs[0];

  const updates = {
    paymentStatus: status,

    updatedAt:
      new Date().toISOString()
  };

  if (transaction) {
    updates.paymentChannel =
      transaction.channel || "";

    if (transaction.paid_at) {
      updates.paidAt =
        transaction.paid_at;
    }
  }

  await doc.ref.update(updates);

  return {
    id: doc.id,
    ...doc.data(),
    ...updates
  };
}

/*
  Verify Paystack transaction.
*/
app.post(
  "/api/paystack/verify",
  async (req, res) => {
    try {
      const reference =
        String(
          req.body?.reference || ""
        ).trim();

      if (!reference) {
        return res.status(400).json({
          error:
            "Payment reference is required."
        });
      }

      const result =
        await paystackRequest(
          `/transaction/verify/${encodeURIComponent(
            reference
          )}`
        );

      const transaction =
        result.data;

      const paid =
        transaction.status ===
          "success" &&
        transaction.currency ===
          "NGN";

      /*
        Payment did not succeed.
      */
      if (!paid) {
        const failedOrder =
          await updateOrderStatus(
            reference,
            "FAILED",
            transaction
          );

        return res.json({
          paid: false,

          status:
            transaction.status ||
            "unknown",

          order:
            failedOrder || {
              paymentReference:
                reference,

              paymentStatus:
                "FAILED"
            }
        });
      }

      /*
        Successful payment.
      */
      const order =
        await savePaidOrder(
          transaction
        );

      res.json({
        paid: true,

        order
      });
    } catch (error) {
      console.error(
        "Payment verification error:",
        error
      );

      res.status(400).json({
        error:
          error.message ||
          "Unable to verify payment."
      });
    }
  }
);

/*
  Save/update verified payment.
*/
async function savePaidOrder(
  transaction
) {
  const reference =
    transaction.reference;

  const metadata =
    typeof transaction.metadata ===
    "string"
      ? JSON.parse(
          transaction.metadata ||
          "{}"
        )
      : transaction.metadata ||
        {};

  const items =
    Array.isArray(metadata.items)
      ? metadata.items
      : [];

  const totalNaira =
    Number(transaction.amount) /
    100;

  const firestore =
    initFirebase();

  /*
    If Firebase isn't configured,
    still return verified payment
    information for testing.
  */
  if (!firestore) {
    return {
      id: reference,

      orderNumber:
        reference,

      paymentReference:
        reference,

      paymentStatus:
        "PAID",

      paymentChannel:
        transaction.channel ||
        "",

      currency:
        transaction.currency ||
        "NGN",

      customer: {
        uid:
          metadata.userId ||
          "",

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

      total:
        totalNaira,

      paidAt:
        transaction.paid_at ||
        new Date().toISOString(),

      createdAt:
        new Date().toISOString()
    };
  }

  /*
    Look for existing order created
    during initialization.
  */
  const existing =
    await firestore
      .collection("orders")
      .where(
        "paymentReference",
        "==",
        reference
      )
      .limit(1)
      .get();

  /*
    If order already exists,
    update it to PAID.
  */
  if (!existing.empty) {
    const doc =
      existing.docs[0];

    const updates = {
      paymentStatus:
        "PAID",

      paymentChannel:
        transaction.channel ||
        "",

      currency:
        transaction.currency ||
        "NGN",

      total:
        totalNaira,

      paidAt:
        transaction.paid_at ||
        new Date().toISOString(),

      updatedAt:
        new Date().toISOString()
    };

    await doc.ref.update(
      updates
    );

    return {
      id: doc.id,

      ...doc.data(),

      ...updates
    };
  }

  /*
    Fallback:
    create the order if the pending
    order wasn't found.
  */
  const order = {
    orderNumber:
      reference,

    paymentReference:
      reference,

    paymentStatus:
      "PAID",

    paymentChannel:
      transaction.channel ||
      "",

    currency:
      transaction.currency ||
      "NGN",

    customer: {
      uid:
        metadata.userId ||
        "",

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

    total:
      totalNaira,

    paidAt:
      transaction.paid_at ||
      new Date().toISOString(),

    createdAt:
      new Date().toISOString(),

    updatedAt:
      new Date().toISOString()
  };

  const doc =
    await firestore
      .collection("orders")
      .add(order);

  return {
    id: doc.id,

    ...order
  };
}

/*
  Get orders belonging to the
  currently authenticated Firebase user.

  SECURITY:
  The Firebase ID token determines
  which user is requesting orders.
*/
app.get(
  "/api/orders",
  requireFirebaseUser,
  async (req, res) => {
    try {
      const firestore =
        initFirebase();

      if (!firestore) {
        return res.status(503).json({
          error:
            "Firebase is not configured."
        });
      }

      const uid =
        req.firebaseUser.uid;

      const snapshot =
        await firestore
          .collection("orders")
          .where(
            "customer.uid",
            "==",
            uid
          )
          .get();

      const orders =
        snapshot.docs
          .map(doc => ({
            id: doc.id,
            ...doc.data()
          }))
          .sort(
            (a, b) =>
              String(
                b.createdAt || ""
              ).localeCompare(
                String(
                  a.createdAt || ""
                )
              )
          );

      res.json({
        ok: true,
        orders
      });
    } catch (error) {
      console.error(
        "Order history error:",
        error
      );

      res.status(500).json({
        error:
          "Unable to load order history."
      });
    }
  }
);

/*
  Get one order belonging to
  the authenticated user.
*/
app.get(
  "/api/orders/:orderId",
  requireFirebaseUser,
  async (req, res) => {
    try {
      const firestore =
        initFirebase();

      if (!firestore) {
        return res.status(503).json({
          error:
            "Firebase is not configured."
        });
      }

      const doc =
        await firestore
          .collection("orders")
          .doc(
            req.params.orderId
          )
          .get();

      if (!doc.exists) {
        return res.status(404).json({
          error:
            "Order not found."
        });
      }

      const order =
        doc.data();

      /*
        Never allow a customer to view
        another customer's order.
      */
      if (
        order.customer?.uid !==
        req.firebaseUser.uid
      ) {
        return res.status(403).json({
          error:
            "You are not allowed to view this order."
        });
      }

      res.json({
        ok: true,

        order: {
          id: doc.id,
          ...order
        }
      });
    } catch (error) {
      console.error(
        "Single order error:",
        error
      );

      res.status(500).json({
        error:
          "Unable to load order."
      });
    }
  }
);

/*
  Paystack webhook.

  Paystack signs webhook requests
  with HMAC SHA-512.
*/
app.post(
  "/api/paystack/webhook",
  express.raw({
    type: "application/json"
  }),
  async (req, res) => {
    try {
      const signature =
        req.headers[
          "x-paystack-signature"
        ];

      if (
        !signature ||
        !process.env
          .PAYSTACK_SECRET_KEY
      ) {
        return res
          .status(401)
          .send(
            "Invalid signature"
          );
      }

      const expected =
        crypto
          .createHmac(
            "sha512",
            process.env
              .PAYSTACK_SECRET_KEY
          )
          .update(req.body)
          .digest("hex");

      const signatureBuffer =
        Buffer.from(
          String(signature)
        );

      const expectedBuffer =
        Buffer.from(expected);

      if (
        signatureBuffer.length !==
          expectedBuffer.length ||
        !crypto.timingSafeEqual(
          signatureBuffer,
          expectedBuffer
        )
      ) {
        return res
          .status(401)
          .send(
            "Invalid signature"
          );
      }

      const event =
        JSON.parse(
          req.body.toString(
            "utf8"
          )
        );

      /*
        Successful payment.
      */
      if (
        event.event ===
        "charge.success"
      ) {
        await savePaidOrder(
          event.data
        );
      }

      /*
        Failed payment.
      */
      if (
        event.event ===
        "charge.failed"
      ) {
        const reference =
          event.data?.reference;

        if (reference) {
          await updateOrderStatus(
            reference,
            "FAILED",
            event.data
          );
        }
      }

      res.sendStatus(200);
    } catch (error) {
      console.error(
        "Paystack webhook error:",
        error
      );

      res.sendStatus(500);
    }
  }
);

/*
  Start server.
*/
app.listen(
  PORT,
  () => {
    console.log(
      `STAYUNKNOWN backend running on port ${PORT}`
    );
  }
);