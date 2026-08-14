require("dotenv").config();

const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

const STORE_EMAIL =
  process.env.STORE_EMAIL || "stayunknown404@icloud.com";

const EMAIL_FROM =
  process.env.EMAIL_FROM ||
  "STAYUNKNOWN <onboarding@resend.dev>";

app.use(cors());

/*
  Paystack webhook requires the original raw body.
*/
app.use((req, res, next) => {
  if (req.path === "/api/paystack/webhook") {
    return next();
  }

  express.json()(req, res, next);
});

/*
  RESEND EMAIL
*/

function escapeEmailHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function sendResendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn(
      "RESEND_API_KEY is not configured. Email skipped."
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

        to: Array.isArray(to)
          ? to
          : [to],

        subject,

        html
      })
    }
  );

  const data =
    await response.json();

  if (!response.ok) {
    throw new Error(
      data?.message ||
      data?.error ||
      "Resend email failed."
    );
  }

  console.log(
    `Resend email sent: ${subject}`
  );

  return data;
}

function buildOrderItemsHtml(items) {
  return (
    Array.isArray(items)
      ? items
      : []
  )
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
          <td style="padding:12px 0;border-bottom:1px solid #ddd;">
            <strong>${name}</strong><br>
            <span style="font-size:13px;color:#666;">
              Qty: ${quantity}
              · Size: ${size}
              · Colour: ${color}
            </span>
          </td>

          <td style="padding:12px 0;border-bottom:1px solid #ddd;text-align:right;">
            ₦${lineTotal.toLocaleString("en-NG")}
          </td>
        </tr>
      `;
    })
    .join("");
}

async function sendOrderConfirmationEmails(order) {
  if (!process.env.RESEND_API_KEY) {
    console.warn(
      "RESEND_API_KEY is not configured. Order emails skipped."
    );
    return;
  }

  const customer =
    order.customer || {};

  const customerEmail =
    String(
      customer.email || ""
    )
      .trim()
      .toLowerCase();

  const customerName =
    String(
      customer.name ||
      "Customer"
    ).trim();

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

  const phone =
    String(
      customer.phone ||
      "Not provided"
    );

  const address =
    String(
      customer.address ||
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
    buildOrderItemsHtml(
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

  const safeEmail =
    escapeEmailHtml(
      customerEmail ||
      "Not provided"
    );

  const safePhone =
    escapeEmailHtml(phone);

  const safeAddress =
    escapeEmailHtml(address);

  const safeNote =
    escapeEmailHtml(note);

  const totalText =
    `₦${total.toLocaleString("en-NG")}`;

  const customerHtml = `
    <div style="font-family:Arial,sans-serif;max-width:650px;margin:auto;color:#111;line-height:1.6;">

      <h1 style="letter-spacing:2px;">
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

      <div style="background:#f5f5f5;padding:16px;margin:20px 0;">
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

      <table style="width:100%;border-collapse:collapse;">
        <tbody>
          ${itemsHtml}
        </tbody>
      </table>

      <p style="text-align:right;font-size:18px;">
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

        <strong>Email:</strong>
        ${safeEmail}<br>

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

    </div>
  `;

  const storeHtml = `
    <div style="font-family:Arial,sans-serif;max-width:650px;margin:auto;color:#111;line-height:1.6;">

      <h1 style="letter-spacing:2px;">
        STAYUNKNOWN
      </h1>

      <h2>
        NEW PAID ORDER
      </h2>

      <p>
        A new order has been successfully paid.
      </p>

      <div style="background:#f5f5f5;padding:16px;margin:20px 0;">
        <strong>Order number:</strong>
        ${safeOrderNumber}<br>

        <strong>Customer:</strong>
        ${safeName}<br>

        <strong>Customer email:</strong>
        ${safeEmail}<br>

        <strong>Payment reference:</strong>
        ${safeReference}<br>

        <strong>Total:</strong>
        ${totalText}
      </div>

      <h3>
        PRODUCTS
      </h3>

      <table style="width:100%;border-collapse:collapse;">
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
        ${safeEmail}<br>

        <strong>Phone:</strong>
        ${safePhone}<br>

        <strong>Address:</strong>
        ${safeAddress}<br>

        <strong>Order note:</strong>
        ${safeNote}
      </p>

    </div>
  `;

  const promises = [];

  if (customerEmail) {
    promises.push(
      sendResendEmail({
        to: customerEmail,

        subject:
          `STAYUNKNOWN — Order ${orderNumber} Confirmed`,

        html:
          customerHtml
      })
    );
  }

  promises.push(
    sendResendEmail({
      to: STORE_EMAIL,

      subject:
        `STAYUNKNOWN — NEW PAID ORDER ${orderNumber}`,

      html:
        storeHtml
    })
  );

  await Promise.all(
    promises
  );
}

/*
  FIREBASE
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
      "Firebase environment variables are not configured."
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
              .replace(/\\n/g, "\n")
        })
    });
  }

  db =
    admin.firestore();

  return db;
}

/*
  FIREBASE AUTH
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
        .slice(7)
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

    req.firebaseUser =
      await admin
        .auth()
        .verifyIdToken(token);

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
  PRODUCT CATALOGUE
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

function findProduct(
  productId
) {
  return catalog.find(
    product =>
      product.id ===
      productId
  );
}

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

      size,

      color,

      lineTotal:
        product.price *
        quantity
    };
  });
}

/*
  PAYSTACK
*/

async function paystackRequest(
  endpoint,
  options = {}
) {
  if (
    !process.env.PAYSTACK_SECRET_KEY
  ) {
    throw new Error(
      "Paystack secret key is not configured."
    );
  }

  const response =
    await fetch(
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

  const data =
    await response.json();

  if (
    !response.ok ||
    !data.status
  ) {
    throw new Error(
      data.message ||
      "Paystack request failed."
    );
  }

  return data;
}

/*
  CREATE PENDING ORDER
*/

async function createPendingOrder({
  reference,
  name,
  email,
  phone,
  address,
  note,
  uid,
  items,
  total
}) {
  const firestore =
    initFirebase();

  if (!firestore) {
    return null;
  }

  const order = {
    orderNumber:
      reference,

    paymentReference:
      reference,

    paymentStatus:
      "PENDING",

    paymentChannel:
      "",

    currency:
      "NGN",

    customer: {
      uid:
        uid || "",

      name:
        name || "",

      email:
        email || "",

      phone:
        phone || "",

      address:
        address || "",

      note:
        note || ""
    },

    items,

    total,

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
    id:
      doc.id,

    ...order
  };
}

/*
  INITIALIZE PAYSTACK
*/

app.post(
  "/api/paystack/initialize",
  async (req, res) => {
    try {
      const {
        name = "",
        email,
        phone = "",
        address = "",
        note = "",
        items,
        callbackUrl = "",
        userId = ""
      } =
        req.body || {};

      const cleanEmail =
        String(
          email || ""
        )
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
        buildTrustedItems(
          items
        );

      const total =
        trustedItems.reduce(
          (sum, item) =>
            sum +
            item.lineTotal,
          0
        );

      const reference =
        `SU-${Date.now()}-${crypto
          .randomBytes(5)
          .toString("hex")
          .toUpperCase()}`;

      const cleanName =
        String(
          name || ""
        ).trim();

      const cleanPhone =
        String(
          phone || ""
        ).trim();

      const cleanAddress =
        String(
          address || ""
        ).trim();

      const cleanNote =
        String(
          note || ""
        ).trim();

      const cleanUserId =
        String(
          userId || ""
        ).trim();

      const metadata = {
        store:
          "STAYUNKNOWN",

        reference,

        name:
          cleanName,

        email:
          cleanEmail,

        phone:
          cleanPhone,

        address:
          cleanAddress,

        note:
          cleanNote,

        userId:
          cleanUserId,

        items:
          trustedItems.map(
            item => ({
              productId:
                item.productId,

              name:
                item.name,

              category:
                item.category,

              price:
                item.price,

              quantity:
                item.quantity,

              size:
                item.size,

              color:
                item.color
            })
          )
      };

      await createPendingOrder({
        reference,

        name:
          cleanName,

        email:
          cleanEmail,

        phone:
          cleanPhone,

        address:
          cleanAddress,

        note:
          cleanNote,

        uid:
          cleanUserId,

        items:
          trustedItems,

        total
      });

      const result =
        await paystackRequest(
          "/transaction/initialize",
          {
            method:
              "POST",

            body:
              JSON.stringify({
                email:
                  cleanEmail,

                amount:
                  total * 100,

                currency:
                  "NGN",

                reference,

                callback_url:
                  callbackUrl ||
                  undefined,

                metadata
              })
          }
        );

      res.json({
        ok:
          true,

        reference,

        access_code:
          result.data.access_code,

        authorization_url:
          result.data.authorization_url,

        amount:
          total,

        currency:
          "NGN"
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
  UPDATE ORDER STATUS
*/

async function updateOrderStatus(
  reference,
  status,
  transaction = null
) {
  const firestore =
    initFirebase();

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

  if (
    snapshot.empty
  ) {
    return null;
  }

  const doc =
    snapshot.docs[0];

  const updates = {
    paymentStatus:
      status,

    updatedAt:
      new Date().toISOString()
  };

  if (transaction) {
    updates.paymentChannel =
      transaction.channel ||
      "";

    if (
      transaction.paid_at
    ) {
      updates.paidAt =
        transaction.paid_at;
    }
  }

  await doc.ref.update(
    updates
  );

  return {
    id:
      doc.id,

    ...doc.data(),

    ...updates
  };
}

/*
  SAVE PAID ORDER
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
    Array.isArray(
      metadata.items
    )
      ? metadata.items
      : [];

  const totalNaira =
    Number(
      transaction.amount
    ) / 100;

  const firestore =
    initFirebase();

  /*
    Firebase unavailable:
    still send email using
    Paystack transaction data.
  */

  if (!firestore) {
    const order = {
      id:
        reference,

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
          "",

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

    try {
      await sendOrderConfirmationEmails(
        order
      );
    } catch (emailError) {
      console.error(
        "Resend order email error:",
        emailError
      );
    }

    return order;
  }

  /*
    Find pending order.
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
    Existing pending order.
  */

  if (
    !existing.empty
  ) {
    const doc =
      existing.docs[0];

    const oldData =
      doc.data();

    const customer = {
      ...(oldData.customer || {}),

      name:
        metadata.name ||
        oldData.customer?.name ||
        "",

      email:
        transaction.customer?.email ||
        metadata.email ||
        oldData.customer?.email ||
        "",

      phone:
        metadata.phone ||
        transaction.customer?.phone ||
        oldData.customer?.phone ||
        "",

      address:
        metadata.address ||
        oldData.customer?.address ||
        "",

      note:
        metadata.note ||
        oldData.customer?.note ||
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

      total:
        totalNaira,

      customer,

      paidAt:
        transaction.paid_at ||
        new Date().toISOString(),

      updatedAt:
        new Date().toISOString()
    };

    /*
      Prevent duplicate emails.
    */

    if (
      oldData.confirmationEmailSentAt
    ) {
      await doc.ref.update(
        updates
      );

      return {
        id:
          doc.id,

        ...oldData,

        ...updates
      };
    }

    await doc.ref.update({
      ...updates,

      confirmationEmailSentAt:
        new Date().toISOString()
    });

    const order = {
      id:
        doc.id,

      ...oldData,

      ...updates
    };

    try {
      await sendOrderConfirmationEmails(
        order
      );
    } catch (emailError) {
      console.error(
        "Resend order email error:",
        emailError
      );

      /*
        Allow another attempt if
        Resend failed.
      */

      await doc.ref.update({
        confirmationEmailSentAt:
          admin.firestore.FieldValue.delete()
      });
    }

    return order;
  }

  /*
    Fallback:
    create a paid order.
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

      name:
        metadata.name ||
        "",

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
      new Date().toISOString(),

    confirmationEmailSentAt:
      new Date().toISOString()
  };

  const doc =
    await firestore
      .collection("orders")
      .add(order);

  const savedOrder = {
    id:
      doc.id,

    ...order
  };

  try {
    await sendOrderConfirmationEmails(
      savedOrder
    );
  } catch (emailError) {
    console.error(
      "Resend order email error:",
      emailError
    );

    await doc.ref.update({
      confirmationEmailSentAt:
        admin.firestore.FieldValue.delete()
    });
  }

  return savedOrder;
}

/*
  VERIFY PAYSTACK PAYMENT
*/

app.post(
  "/api/paystack/verify",
  async (req, res) => {
    try {
      const reference =
        String(
          req.body?.reference ||
          ""
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
          paid:
            false,

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
        paid:
          true,

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
  ORDER HISTORY
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

      const snapshot =
        await firestore
          .collection("orders")
          .where(
            "customer.uid",
            "==",
            req.firebaseUser.uid
          )
          .get();

      const orders =
        snapshot.docs
          .map(doc => ({
            id:
              doc.id,

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
        ok:
          true,

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
  SINGLE ORDER
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
        ok:
          true,

        order: {
          id:
            doc.id,

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
  HEALTH CHECK
*/

app.get(
  "/api/health",
  (_req, res) => {
    res.json({
      ok:
        true,

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

      emailFrom:
        EMAIL_FROM,

      storeEmail:
        STORE_EMAIL
    });
  }
);

/*
  PUBLIC CATALOGUE
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
  PAYSTACK WEBHOOK
*/

app.post(
  "/api/paystack/webhook",
  express.raw({
    type:
      "application/json"
  }),
  async (req, res) => {
    try {
      const signature =
        req.headers[
          "x-paystack-signature"
        ];

      if (
        !signature ||
        !process.env.PAYSTACK_SECRET_KEY
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
            process.env.PAYSTACK_SECRET_KEY
          )
          .update(req.body)
          .digest("hex");

      const signatureBuffer =
        Buffer.from(
          String(signature)
        );

      const expectedBuffer =
        Buffer.from(
          expected
        );

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
  START SERVER
*/

app.listen(
  PORT,
  () => {
    console.log(
      `STAYUNKNOWN backend running on port ${PORT}`
    );
  }
);