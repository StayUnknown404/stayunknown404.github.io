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
      const name =
        escapeEmailHtml(
          item.name ||
          item.productId ||
          "Product"
        );

      const quantity =
        Number(item.quantity || 0);

      const size =
        escapeEmailHtml(
          item.size || "-"
        );

      const color =
        escapeEmailHtml(
          item.color || "-"
        );

      const lineTotal =
        Number(item.lineTotal || 0);

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

async function sendOrderConfirmationEmails(order) {
  if (!process.env.RESEND_API_KEY) {
    console.warn(
      "RESEND_API_KEY is not configured; order emails skipped."
    );
    return;
  }

  const customer =
    order?.customer || {};

  const customerEmail =
    String(
      customer.email || ""
    )
      .trim()
      .toLowerCase();

  if (!customerEmail) {
    console.warn(
      `No customer email for order ${
        order?.orderNumber || "unknown"
      }; customer email skipped.`
    );
  }

  const customerName =
    String(
      customer.name ||
      "Customer"
    ).trim() ||
    "Customer";

  const orderNumber =
    String(
      order.orderNumber ||
      order.paymentReference ||
      ""
    );

  const paymentReference =
    String(
      order.paymentReference ||
      orderNumber
    );

  const address =
    String(
      customer.address ||
      "Not provided"
    );

  const phone =
    String(
      customer.phone ||
      "Not provided"
    );

  const note =
    String(
      customer.note ||
      "None"
    );

  const total =
    Number(order.total || 0);

  const itemsHtml =
    buildOrderEmailItems(
      order.items
    );

  const safeName =
    escapeEmailHtml(
      customerName
    );

  const safeOrderNumber =
    escapeEmailHtml(
      orderNumber
    );

  const safeReference =
    escapeEmailHtml(
      paymentReference
    );

  const safeAddress =
    escapeEmailHtml(
      address
    );

  const safePhone =
    escapeEmailHtml(
      phone
    );

  const safeNote =
    escapeEmailHtml(
      note
    );

  const totalText =
    `₦${total.toLocaleString("en-NG")}`;

  const customerHtml = `
    <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#111;line-height:1.6">

      <h1 style="font-size:24px;letter-spacing:1px">
        STAYUNKNOWN
      </h1>

      <h2>
        ORDER CONFIRMED
      </h2>

      <p>
        Thank you for shopping with
        <strong>STAYUNKNOWN</strong>
        - ${safeName}.
      </p>

      <p>
        Your payment has been successfully confirmed.
      </p>

      <div style="background:#f7f7f7;padding:16px;margin:20px 0">

        <strong>Order number:</strong>
        ${safeOrderNumber}<br>

        <strong>Payment status:</strong>
        PAID<br>

        <strong>Payment reference:</strong>
        ${safeReference}

      </div>

      <h3>
        YOUR ORDER
      </h3>

      <table style="width:100%;border-collapse:collapse">
        <tbody>
          ${itemsHtml}
        </tbody>
      </table>

      <p style="text-align:right;font-size:18px">
        <strong>
          Total: ${totalText}
        </strong>
      </p>

      <h3>
        DELIVERY INFORMATION
      </h3>

      <p>

        <strong>Name:</strong>
        ${safeName}<br>

        <strong>Phone:</strong>
        ${safePhone}<br>

        <strong>Address:</strong>
        ${safeAddress}<br>

        <strong>Order note:</strong>
        ${safeNote}

      </p>

      <p>
        Thanks again for shopping with STAYUNKNOWN.
      </p>

    </div>`;

  const storeHtml = `
    <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#111;line-height:1.6">

      <h1 style="font-size:24px;letter-spacing:1px">
        STAYUNKNOWN
      </h1>

      <h2>
        NEW ORDER — PAID
      </h2>

      <p>
        <strong>${safeName}</strong>
        has placed a successful order.
      </p>

      <div style="background:#f7f7f7;padding:16px;margin:20px 0">

        <strong>Order number:</strong>
        ${safeOrderNumber}<br>

        <strong>Customer email:</strong>
        ${escapeEmailHtml(
          customerEmail ||
          "Not provided"
        )}<br>

        <strong>Payment reference:</strong>
        ${safeReference}<br>

        <strong>Total:</strong>
        ${totalText}

      </div>

      <h3>
        PRODUCTS
      </h3>

      <table style="width:100%;border-collapse:collapse">
        <tbody>
          ${itemsHtml}
        </tbody>
      </table>

      <h3>
        DELIVERY INFORMATION
      </h3>

      <p>

        <strong>Name:</strong>
        ${safeName}<br>

        <strong>Email:</strong>
        ${escapeEmailHtml(
          customerEmail ||
          "Not provided"
        )}<br>

        <strong>Phone:</strong>
        ${safePhone}<br>

        <strong>Address:</strong>
        ${safeAddress}<br>

        <strong>Order note:</strong>
        ${safeNote}

      </p>

    </div>`;

  const sends = [];

  if (customerEmail) {
    sends.push(
      sendResendEmail({
        to: customerEmail,

        subject:
          `STAYUNKNOWN — Order ${orderNumber} Confirmed`,

        html:
          customerHtml
      })
    );
  }

  sends.push(
    sendResendEmail({
      to: STORE_EMAIL,

      subject:
        `STAYUNKNOWN — NEW PAID ORDER ${orderNumber}`,

      html:
        storeHtml
    })
  );

  await Promise.all(
    sends
  );
}

app.use(cors());

/*
  Paystack webhook needs the original raw request body
  so its HMAC signature can be verified.
*/
app.use((req, res, next) => {
  if (
    req.path ===
    "/api/paystack/webhook"
  ) {
    return next();
  }

  return express.json()(req, res, next);
});

/*
  Trusted server-side product catalogue.
*/
const catalogPath =
  path.join(
    __dirname,
    "catalog.json"
  );

const catalog =
  JSON.parse(
    fs.readFileSync(
      catalogPath,
      "utf8"
    )
  );

/*
  Firebase Admin
*/
let db = null;

function initFirebase() {
  if (db) {
    return db;
  }

  if (
    !process.env.FIREBASE_PROJECT_ID ||
    !process.env.FIREBASE_CLIENT_EMAIL ||
    !process.env.FIREBASE_PRIVATE_KEY
  ) {
    console.warn(
      "Firebase environment variables are not configured yet."
    );

    return null;
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential:
        admin.credential.cert({
          projectId:
            process.env.FIREBASE_PROJECT_ID,

          clientEmail:
            process.env.FIREBASE_CLIENT_EMAIL,

          privateKey:
            process.env.FIREBASE_PRIVATE_KEY
              .replace(
                /\\n/g,
                "\n"
              )
        })
    });
  }

  db =
    admin.firestore();

  return db;
}

/*
  Firebase authentication middleware.
*/
async function requireFirebaseUser(
  req,
  res,
  next
) {
  try {
    const authorization =
      String(
        req.headers.authorization ||
        ""
      );

    if (
      !authorization.startsWith(
        "Bearer "
      )
    ) {
      return res.status(401).json({
        error:
          "Authentication required."
      });
    }

    const token =
      authorization
        .slice(
          "Bearer ".length
        )
        .trim();

    if (!token) {
      return res.status(401).json({
        error:
          "Authentication token is missing."
      });
    }

    const firebase =
      initFirebase();

    if (!firebase) {
      return res.status(503).json({
        error:
          "Firebase is not configured on the server."
      });
    }

    const decoded =
      await admin
        .auth()
        .verifyIdToken(
          token
        );

    req.firebaseUser =
      decoded;

    next();

  } catch (error) {

    console.error(
      "Firebase authentication error:",
      error
    );

    return res.status(401).json({
      error:
        "Invalid or expired authentication token."
    });
  }
}

/*
  Health check
*/
app.get(
  "/api/health",
  (_req, res) => {
    res.json({
      ok: true,

      service:
        "STAYUNKNOWN Paystack Backend",

      paystackConfigured:
        Boolean(
          process.env.PAYSTACK_SECRET_KEY
        ),

      firebaseConfigured:
        Boolean(
          process.env.FIREBASE_PROJECT_ID &&
          process.env.FIREBASE_CLIENT_EMAIL &&
          process.env.FIREBASE_PRIVATE_KEY
        ),

      resendConfigured:
        Boolean(
          process.env.RESEND_API_KEY
        ),

      adminConfigured:
        Boolean(
          process.env.ADMIN_EMAIL ||
          process.env.ADMIN_EMAILS
        )
    });
  }
);

/*
  Public catalogue endpoint.
*/
app.get(
  "/api/catalog",
  (_req, res) => {
    res.json({
      products:
        catalog
    });
  }
);

/*
  Find product in trusted
  server-side catalogue.
*/
function findProduct(
  productId
) {
  return catalog.find(
    product =>
      product.id ===
      productId
  );
}

/*
  Build trusted cart items.
*/
function buildTrustedItems(
  items
) {
  if (
    !Array.isArray(items) ||
    items.length === 0
  ) {
    throw new Error(
      "Cart is empty."
    );
  }

  return items.map(item => {

    const product =
      findProduct(
        item.productId
      );

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

    const quantity =
      Number(
        item.quantity
      );

    if (
      !Number.isInteger(
        quantity
      ) ||
      quantity < 1 ||
      quantity > 20
    ) {
      throw new Error(
        `Invalid quantity for ${product.name}.`
      );
    }

    const size =
      String(
        item.size || ""
      ).trim();

    const color =
      String(
        item.color || ""
      ).trim();

    if (
      !size ||
      !color
    ) {
      throw new Error(
        `Size and colour are required for ${product.name}.`
      );
    }

    if (
      !product.sizes.includes(
        size
      )
    ) {
      throw new Error(
        `Invalid size for ${product.name}.`
      );
    }

    if (
      !product.colors.includes(
        color
      )
    ) {
      throw new Error(
        `Invalid colour for ${product.name}.`
      );
    }

    return {
      productId:
        product.id,

      name:
        product.name,

      category:
        product.category,

      price:
        product.price,

      quantity,