require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

/*
  Resend transactional email configuration.
  Keep the API key in Render environment variables.
*/
const STORE_EMAIL =
  process.env.STORE_EMAIL ||
  "stayunknown404@icloud.com";

const EMAIL_FROM =
  process.env.EMAIL_FROM ||
  "STAYUNKNOWN <onboarding@resend.dev>";

async function sendResendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn(
      "RESEND_API_KEY is not configured; email notification skipped."
    );
    return null;
  }

  const response = await fetch(
    "https://api.resend.com/emails",
    {
      method: "POST",
      headers: {
        Authorization:
          `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type":
          "application/json"
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: Array.isArray(to) ? to : [to],
        subject,
        html
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data?.message ||
      data?.error ||
      "Resend email request failed."
    );
  }

  return data;
}

function escapeEmailHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function buildOrderEmailItems(items) {
  return (Array.isArray(items) ? items : [])
    .map(item => {
      const name = escapeEmailHtml(item.name || item.productId || "Product");
      const quantity = Number(item.quantity || 0);
      const size = escapeEmailHtml(item.size || "-");
      const color = escapeEmailHtml(item.color || "-");
      const lineTotal = Number(item.lineTotal || 0);

      return `
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #eee">
            <strong>${name}</strong><br>
            <span style="color:#666;font-size:13px">
              Qty: ${quantity} · Size: ${size} · Colour: ${color}
            </span>
          </td>
          <td style="padding:10px 0;border-bottom:1px solid #eee;text-align:right">
            ₦${lineTotal.toLocaleString("en-NG")}
          </td>
        </tr>`;
    })
    .join("");
}

async function sendGuestDeliveryStatusEmail(order, delivery) {
  if (!process.env.RESEND_API_KEY) {
    console.warn(
      "RESEND_API_KEY is not configured; guest delivery status email skipped."
    );
    return;
  }

  const customer = order?.customer || {};
  const customerEmail =
    String(customer.email || "").trim().toLowerCase();

  // Only guests receive these status emails.
  // Registered customers already receive the website notifications.
  if (!customerEmail || String(customer.uid || "").trim()) {
    return;
  }

  const status =
    String(delivery?.status || "").trim().toUpperCase();

  const statusLabels = {
    PROCESSING: "BEING PREPARED",
    SHIPPED: "SHIPPED",
    DELIVERED: "DELIVERED"
  };

  const statusLabel =
    statusLabels[status] || status;

  if (!["PROCESSING", "SHIPPED", "DELIVERED"].includes(status)) {
    return;
  }

  const customerName =
    String(customer.name || "Customer").trim() || "Customer";

  const orderNumber =
    String(order.orderNumber || order.paymentReference || "");

  const estimatedDelivery =
    String(delivery?.estimatedDelivery || "To be updated").trim() ||
    "To be updated";

  const courier =
    String(delivery?.courier || "STAYUNKNOWN DELIVERY").trim() ||
    "STAYUNKNOWN DELIVERY";

  const trackingNumber =
    String(delivery?.trackingNumber || "").trim();

  const deliveryNote =
    String(delivery?.note || "").trim();

  const itemsHtml =
    buildOrderEmailItems(order.items);

  const safeName = escapeEmailHtml(customerName);
  const safeOrderNumber = escapeEmailHtml(orderNumber);
  const safeStatus = escapeEmailHtml(statusLabel);
  const safeEstimatedDelivery = escapeEmailHtml(estimatedDelivery);
  const safeCourier = escapeEmailHtml(courier);
  const safeTrackingNumber = escapeEmailHtml(trackingNumber);
  const safeDeliveryNote = escapeEmailHtml(deliveryNote);

  const customerHtml = `
    <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#111;line-height:1.6">
      <h1 style="font-size:24px;letter-spacing:1px">STAYUNKNOWN</h1>
      <h2>ORDER UPDATE</h2>
      <p>Hi <strong>${safeName}</strong>,</p>
      <p>Your STAYUNKNOWN order <strong>${safeOrderNumber}</strong> has been updated.</p>

      <div style="background:#f7f7f7;padding:16px;margin:20px 0">
        <strong>Status:</strong> ${safeStatus}<br>
        <strong>Estimated delivery:</strong> ${safeEstimatedDelivery}<br>
        <strong>Courier:</strong> ${safeCourier}${
          trackingNumber
            ? `<br><strong>Tracking number:</strong> ${safeTrackingNumber}`
            : ""
        }${
          deliveryNote
            ? `<br><strong>Delivery note:</strong> ${safeDeliveryNote}`
            : ""
        }
      </div>

      <h3>YOUR ORDER</h3>
      <table style="width:100%;border-collapse:collapse">
        <tbody>${itemsHtml}</tbody>
      </table>

      <p>Thank you for shopping with STAYUNKNOWN.</p>
    </div>`;

  await sendResendEmail({
    to: customerEmail,
    subject: `STAYUNKNOWN — Order ${orderNumber} ${statusLabel}`,
    html: customerHtml
  });
}

async function sendOrderConfirmationEmails(order) {
  if (!process.env.RESEND_API_KEY) {
    console.warn(
      "RESEND_API_KEY is not configured; order emails skipped."
    );
    return;
  }

  const customer = order?.customer || {};
  const customerEmail =
    String(customer.email || "").trim().toLowerCase();

  if (!customerEmail) {
    console.warn(
      `No customer email for order ${order?.orderNumber || "unknown"}; customer email skipped.`
    );
  }

  const customerName =
    String(customer.name || "Customer").trim() || "Customer";
  const orderNumber =
    String(order.orderNumber || order.paymentReference || "");
  const paymentReference =
    String(order.paymentReference || orderNumber);
  const address =
    String(customer.address || "Not provided");
  const phone =
    String(customer.phone || "Not provided");
  const note =
    String(customer.note || "None");
  const total = Number(order.total || 0);
  const itemsHtml =
    buildOrderEmailItems(order.items);

  const safeName = escapeEmailHtml(customerName);
  const safeOrderNumber = escapeEmailHtml(orderNumber);
  const safeReference = escapeEmailHtml(paymentReference);
  const safeAddress = escapeEmailHtml(address);
  const safePhone = escapeEmailHtml(phone);
  const safeNote = escapeEmailHtml(note);
  const totalText = `₦${total.toLocaleString("en-NG")}`;

  const customerHtml = `
    <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#111;line-height:1.6">
      <h1 style="font-size:24px;letter-spacing:1px">STAYUNKNOWN</h1>
      <h2>ORDER CONFIRMED</h2>
      <p>Thank you for shopping with <strong>STAYUNKNOWN</strong> - ${safeName}.</p>
      <p>Your payment has been successfully confirmed.</p>

      <div style="background:#f7f7f7;padding:16px;margin:20px 0">
        <strong>Order number:</strong> ${safeOrderNumber}<br>
        <strong>Payment status:</strong> PAID<br>
        <strong>Payment reference:</strong> ${safeReference}
      </div>

      <h3>YOUR ORDER</h3>
      <table style="width:100%;border-collapse:collapse">
        <tbody>${itemsHtml}</tbody>
      </table>
      <p style="text-align:right;font-size:18px"><strong>Total: ${totalText}</strong></p>

      <h3>DELIVERY INFORMATION</h3>
      <p>
        <strong>Name:</strong> ${safeName}<br>
        <strong>Phone:</strong> ${safePhone}<br>
        <strong>Address:</strong> ${safeAddress}<br>
        <strong>Order note:</strong> ${safeNote}
      </p>

      <p>Thanks again for shopping with STAYUNKNOWN.</p>
    </div>`;

  const storeHtml = `
    <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#111;line-height:1.6">
      <h1 style="font-size:24px;letter-spacing:1px">STAYUNKNOWN</h1>
      <h2>NEW ORDER — PAID</h2>
      <p><strong>${safeName}</strong> has placed a successful order.</p>

      <div style="background:#f7f7f7;padding:16px;margin:20px 0">
        <strong>Order number:</strong> ${safeOrderNumber}<br>
        <strong>Customer email:</strong> ${escapeEmailHtml(customerEmail || "Not provided")}<br>
        <strong>Payment reference:</strong> ${safeReference}<br>
        <strong>Total:</strong> ${totalText}
      </div>

      <h3>PRODUCTS</h3>
      <table style="width:100%;border-collapse:collapse">
        <tbody>${itemsHtml}</tbody>
      </table>

      <h3>DELIVERY INFORMATION</h3>
      <p>
        <strong>Name:</strong> ${safeName}<br>
        <strong>Email:</strong> ${escapeEmailHtml(customerEmail || "Not provided")}<br>
        <strong>Phone:</strong> ${safePhone}<br>
        <strong>Address:</strong> ${safeAddress}<br>
        <strong>Order note:</strong> ${safeNote}
      </p>
    </div>`;

  const sends = [];

  if (customerEmail) {
    sends.push(
      sendResendEmail({
        to: customerEmail,
        subject: `STAYUNKNOWN — Order ${orderNumber} Confirmed`,
        html: customerHtml
      })
    );
  }

  sends.push(
    sendResendEmail({
      to: STORE_EMAIL,
      subject: `STAYUNKNOWN — NEW PAID ORDER ${orderNumber}`,
      html: storeHtml
    })
  );

  await Promise.all(sends);
}

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
*/
async function createPendingOrder({
  reference,
  email,
  phone,
  uid,
  name,
  address,
  note,
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
      name: name || "",
      email: email || "",
      phone: phone || "",
      address: address || "",
      note: note || ""
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
        name = "",
        address = "",
        note = "",
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

      const cleanName =
        String(name || "").trim();

      const cleanAddress =
        String(address || "").trim();

      const cleanNote =
        String(note || "").trim();

      const cleanUserId =
        String(userId || "").trim();

      const metadata = {
        store: "STAYUNKNOWN",

        reference,

        email: cleanEmail,

        phone: cleanPhone,

        name: cleanName,

        address: cleanAddress,

        note: cleanNote,

        userId: cleanUserId,

        items:
          trustedItems.map(item => ({
            productId: item.productId,
            name: item.name,
            category: item.category,
            price: item.price,
            quantity: item.quantity,
            size: item.size,
            color: item.color,
            lineTotal: item.lineTotal
          }))
      };

      await createPendingOrder({
        reference,
        email: cleanEmail,
        phone: cleanPhone,
        uid: cleanUserId,
        name: cleanName,
        address: cleanAddress,
        note: cleanNote,
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

        name:
          metadata.name ||
          "Customer",

        email:
          transaction.customer?.email ||
          metadata.email ||
          "",

        phone:
          metadata.phone ||
          transaction.customer?.phone ||
          "",

        address:
          metadata.address ||
          "",

        note:
          metadata.note ||
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

  if (!existing.empty) {
    const doc =
      existing.docs[0];

    const existingData =
      doc.data() || {};

    const existingCustomer =
      existingData.customer || {};

    const updatedCustomer = {
      ...existingCustomer,

      uid:
        existingCustomer.uid ||
        metadata.userId ||
        "",

      name:
        existingCustomer.name ||
        metadata.name ||
        "Customer",

      email:
        existingCustomer.email ||
        transaction.customer?.email ||
        metadata.email ||
        "",

      phone:
        existingCustomer.phone ||
        metadata.phone ||
        transaction.customer?.phone ||
        "",

      address:
        existingCustomer.address ||
        metadata.address ||
        "",

      note:
        existingCustomer.note ||
        metadata.note ||
        ""
    };

    const updates = {
      paymentStatus:
        "PAID",

      paymentChannel:
        transaction.channel ||
        "",

      currency:
        transaction.currency ||
        "NGN",

      customer:
        updatedCustomer,

      items:
        existingData.items?.length
          ? existingData.items
          : items,

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

    const savedOrder = {
      id: doc.id,

      ...existingData,

      ...updates
    };

    try {
      if (!existingData.confirmationEmailSentAt) {
        await sendOrderConfirmationEmails(
          savedOrder
        );

        await doc.ref.update({
          confirmationEmailSentAt:
            new Date().toISOString()
        });
      }
    } catch (emailError) {
      console.error(
        "Order confirmation email error:",
        emailError
      );
    }

    return savedOrder;
  }

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

      name:
        metadata.name ||
        "Customer",

      email:
        transaction.customer?.email ||
        metadata.email ||
        "",

      phone:
        metadata.phone ||
        transaction.customer?.phone ||
        "",

      address:
        metadata.address ||
        "",

      note:
        metadata.note ||
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

  const savedOrder = {
    id: doc.id,
    ...order
  };

  try {
    await doc.ref.update({
      confirmationEmailSentAt:
        new Date().toISOString()
    });

    await sendOrderConfirmationEmails(
      savedOrder
    );
  } catch (emailError) {
    console.error(
      "Order confirmation email error:",
      emailError
    );
  }

  return savedOrder;
}

/*
  Get orders belonging to the
  currently authenticated Firebase user.
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
  ADMIN / DELIVERY MANAGEMENT

  ADMIN_EMAIL must be set in Render Environment Variables.
  Multiple admin emails can be separated with commas.
*/
function getAdminEmails() {
  return String(process.env.ADMIN_EMAIL || "")
    .split(",")
    .map(email => email.trim().toLowerCase())
    .filter(Boolean);
}

async function requireAdmin(req, res, next) {
  try {
    await new Promise((resolve, reject) => {
      requireFirebaseUser(req, res, err => {
        if (err) reject(err);
        else resolve();
      });
    });

    const email = String(
      req.firebaseUser?.email || ""
    ).trim().toLowerCase();

    const admins = getAdminEmails();

    if (!email || !admins.includes(email)) {
      return res.status(403).json({
        error: "Admin access required.",
        isAdmin: false
      });
    }

    req.isAdmin = true;
    next();
  } catch (error) {
    console.error(
      "Admin authentication error:",
      error
    );

    if (!res.headersSent) {
      return res.status(401).json({
        error:
          "Authentication required.",
        isAdmin: false
      });
    }
  }
}

app.get(
  "/api/admin/me",
  requireFirebaseUser,
  (req, res) => {
    const email = String(
      req.firebaseUser?.email || ""
    ).trim().toLowerCase();

    const isAdmin = Boolean(
      email &&
      getAdminEmails().includes(email)
    );

    res.json({
      ok: true,
      isAdmin,
      email
    });
  }
);

app.get(
  "/api/admin/orders",
  requireAdmin,
  async (_req, res) => {
    try {
      const firestore =
        initFirebase();

      if (!firestore) {
        return res.status(503).json({
          error:
            "Firebase is not configured."
        });
      }

      const snapshot =
        await firestore
          .collection("orders")
          .get();

      const orders =
        snapshot.docs
          .map(doc => ({
            id: doc.id,
            ...doc.data()
          }))
          .filter(order => {
            const paymentStatus =
              String(
                order.paymentStatus || ""
              ).toUpperCase();

            return (
              paymentStatus === "PAID" ||
              paymentStatus === "PROCESSING" ||
              paymentStatus === "SHIPPED" ||
              paymentStatus === "DELIVERED" ||
              Boolean(
                order.deliveryStatus
              )
            );
          })
          .sort((a, b) =>
            String(
              b.createdAt || ""
            ).localeCompare(
              String(
                a.createdAt || ""
              )
            )
          );

      return res.json({
        ok: true,
        orders
      });
    } catch (error) {
      console.error(
        "Admin orders error:",
        error
      );

      return res.status(500).json({
        error:
          "Unable to load delivery orders."
      });
    }
  }
);

app.patch(
  "/api/admin/orders/:orderId/delivery",
  requireAdmin,
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

      const allowedStatuses = [
        "PAID",
        "PROCESSING",
        "SHIPPED",
        "DELIVERED"
      ];

      const body =
        req.body || {};

      const deliveryStatus =
        String(
          body.deliveryStatus ||
          body.status ||
          "PAID"
        )
          .trim()
          .toUpperCase();

      if (
        !allowedStatuses.includes(
          deliveryStatus
        )
      ) {
        return res.status(400).json({
          error:
            "Invalid delivery status."
        });
      }

      const orderRef =
        firestore
          .collection("orders")
          .doc(
            req.params.orderId
          );

      const orderSnap =
        await orderRef.get();

      if (!orderSnap.exists) {
        return res.status(404).json({
          error:
            "Order not found."
        });
      }

      const existing =
        orderSnap.data() || {};

      const now =
        new Date().toISOString();

      const delivery = {
        status:
          deliveryStatus,

        estimatedDelivery:
          String(
            body.estimatedDelivery ||
            ""
          ).trim(),

        courier:
          String(
            body.courier ||
            ""
          ).trim(),

        trackingNumber:
          String(
            body.trackingNumber ||
            ""
          ).trim(),

        note:
          String(
            body.deliveryNote ||
            body.note ||
            ""
          ).trim(),

        updatedAt:
          now,

        updatedBy:
          String(
            req.firebaseUser?.email ||
            ""
          )
            .trim()
            .toLowerCase()
      };

      await orderRef.update({
        deliveryStatus,

        delivery,

        updatedAt:
          now
      });

      const updatedOrder = {
        id:
          orderSnap.id,

        ...existing,

        deliveryStatus,

        delivery,

        updatedAt:
          now
      };

      try {
        await sendGuestDeliveryStatusEmail(
          updatedOrder,
          delivery
        );
      } catch (emailError) {
        console.error(
          "Guest delivery status email error:",
          emailError
        );
      }

      return res.json({
        ok: true,

        order: {
          ...updatedOrder
        }
      });
    } catch (error) {
      console.error(
        "Admin delivery update error:",
        error
      );

      return res.status(500).json({
        error:
          "Unable to update delivery status."
      });
    }
  }
);

/*
  Paystack webhook.
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

      if (
        event.event ===
        "charge.success"
      ) {
        await savePaidOrder(
          event.data
        );
      }

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