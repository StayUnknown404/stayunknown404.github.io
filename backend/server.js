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

/* Parse JSON before authenticated account APIs. The Paystack webhook is
   intentionally excluded because it must receive the original raw body. */
app.use((req, res, next) => {
  if (req.path === "/api/paystack/webhook") return next();
  return express.json({ limit: "8mb" })(req, res, next);
});

function deliveryStatusLabel(status) {
  const value = String(status || "").toUpperCase();
  if (value === "PROCESSING") return "ORDER BEING PREPARED";
  if (value === "SHIPPED") return "ORDER SHIPPED";
  if (value === "DELIVERED") return "ORDER DELIVERED";
  return `ORDER ${value || "UPDATED"}`;
}

async function sendOrderStatusEmail(order, deliveryStatus, delivery = {}) {
  const customer = order?.customer || {};
  const customerEmail = String(customer.email || "").trim().toLowerCase();
  if (!customerEmail) return;
  const status = String(deliveryStatus || "").toUpperCase();
  if (!["PROCESSING", "SHIPPED", "DELIVERED"].includes(status)) return;

  const customerName = escapeEmailHtml(String(customer.name || "Customer").trim() || "Customer");
  const orderNumber = escapeEmailHtml(String(order.orderNumber || order.paymentReference || order.id || ""));
  const statusTitle = deliveryStatusLabel(status);
  const estimatedDelivery = escapeEmailHtml(String(delivery.estimatedDelivery || order.estimatedDelivery || "To be updated"));
  const courier = escapeEmailHtml(String(delivery.courier || order.courier || "STAYUNKNOWN DELIVERY"));
  const trackingNumber = escapeEmailHtml(String(delivery.trackingNumber || order.trackingNumber || ""));
  const deliveryNote = escapeEmailHtml(String(delivery.note || order.deliveryNote || ""));
  const itemsHtml = buildOrderEmailItems(order.items);
  const statusMessage = status === "PROCESSING"
    ? "Your STAYUNKNOWN order is now being prepared."
    : status === "SHIPPED"
      ? "Your STAYUNKNOWN order has been shipped and is on the way."
      : "Your STAYUNKNOWN order has been marked as delivered.";
  const extraDetails = status === "DELIVERED" ? "" : `
    <div style="background:#f7f7f7;padding:16px;margin:20px 0">
      <strong>Estimated delivery:</strong> ${estimatedDelivery}<br>
      <strong>Courier:</strong> ${courier}
      ${trackingNumber ? `<br><strong>Tracking number:</strong> ${trackingNumber}` : ""}
      ${deliveryNote ? `<br><strong>Delivery note:</strong> ${deliveryNote}` : ""}
    </div>`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:620px;margin:0 auto;color:#111;line-height:1.6">
      <h1 style="font-size:24px;letter-spacing:1px">STAYUNKNOWN</h1>
      <h2>${escapeEmailHtml(statusTitle)}</h2>
      <p>Hello <strong>${customerName}</strong>,</p>
      <p>${statusMessage}</p>
      <div style="background:#f7f7f7;padding:16px;margin:20px 0">
        <strong>Order number:</strong> ${orderNumber}<br>
        <strong>Status:</strong> ${escapeEmailHtml(status)}
      </div>
      <h3>YOUR ORDER</h3>
      <table style="width:100%;border-collapse:collapse">${itemsHtml}</table>
      ${extraDetails}
      <p>Thank you for shopping with <strong>STAYUNKNOWN</strong>.</p>
    </div>`;

  await sendResendEmail({
    to: customerEmail,
    subject: `STAYUNKNOWN — ${statusTitle}${orderNumber ? ` — ${orderNumber}` : ""}`,
    html
  });
}

async function createOrderStatusNotification(order, deliveryStatus, delivery = {}) {
  const firestore = initFirebase();
  const uid = String(order?.customer?.uid || "").trim();
  if (!firestore || !uid) return null;
  const status = String(deliveryStatus || "").toUpperCase();
  if (!["PROCESSING", "SHIPPED", "DELIVERED"].includes(status)) return null;

  const notification = {
    uid,
    orderId: String(order.id || ""),
    orderNumber: String(order.orderNumber || order.paymentReference || order.id || ""),
    title: deliveryStatusLabel(status),
    message: status === "PROCESSING"
      ? "Your STAYUNKNOWN order is now being prepared."
      : status === "SHIPPED"
        ? "Your STAYUNKNOWN order has been shipped and is on the way."
        : "Your STAYUNKNOWN order has been marked as delivered.",
    deliveryStatus: status,
    estimatedDelivery: String(delivery.estimatedDelivery || "").trim(),
    courier: String(delivery.courier || "").trim(),
    trackingNumber: String(delivery.trackingNumber || "").trim(),
    deliveryNote: String(delivery.note || "").trim(),
    read: false,
    readAt: null,
    createdAt: new Date().toISOString()
  };
  const doc = await firestore.collection("notifications").add(notification);
  return { id: doc.id, ...notification };
}

app.get("/api/wishlist", requireFirebaseUser, async (req, res) => {
  try {
    const firestore = initFirebase();
    if (!firestore) return res.status(503).json({ error: "Firebase is not configured." });
    const uid = String(req.firebaseUser.uid || "").trim();
    const snap = await firestore.collection("users").doc(uid).get();
    const data = snap.exists ? (snap.data() || {}) : {};
    const wishlistIds = Array.isArray(data.wishlistIds) ? data.wishlistIds.slice(0, 100) : [];
    return res.json({ ok: true, wishlistIds });
  } catch (error) {
    console.error("Wishlist load error:", error);
    return res.status(500).json({ error: "Unable to load wishlist." });
  }
});

app.put("/api/wishlist", requireFirebaseUser, async (req, res) => {
  try {
    const firestore = initFirebase();
    if (!firestore) return res.status(503).json({ error: "Firebase is not configured." });
    const uid = String(req.firebaseUser.uid || "").trim();
    const incoming = Array.isArray(req.body?.wishlistIds) ? req.body.wishlistIds : [];
    const wishlistIds = [...new Set(incoming.map(id => String(id || "").trim()).filter(Boolean))].slice(0, 100);
    await firestore.collection("users").doc(uid).set({ wishlistIds, updatedAt: new Date().toISOString() }, { merge: true });
    return res.json({ ok: true, wishlistIds });
  } catch (error) {
    console.error("Wishlist save error:", error);
    return res.status(500).json({ error: "Unable to save wishlist." });
  }
});

app.get("/api/profile", requireFirebaseUser, async (req,res)=>{try{const firestore=initFirebase();if(!firestore)return res.status(503).json({error:"Firebase is not configured."});const uid=String(req.firebaseUser.uid||"").trim();const snap=await firestore.collection("users").doc(uid).get();const d=snap.exists?(snap.data()||{}):{};return res.json({ok:true,profile:{phone:String(d.phone||"").trim(),address:String(d.address||"").trim()}})}catch(e){console.error("Profile load error:",e);return res.status(500).json({error:"Unable to load saved checkout information."})}});
app.put("/api/profile", requireFirebaseUser, async (req,res)=>{try{const firestore=initFirebase();if(!firestore)return res.status(503).json({error:"Firebase is not configured."});const uid=String(req.firebaseUser.uid||"").trim();const phone=String(req.body?.phone||"").trim().slice(0,60);const address=String(req.body?.address||"").trim().slice(0,500);await firestore.collection("users").doc(uid).set({phone,address,updatedAt:new Date().toISOString()},{merge:true});return res.json({ok:true,profile:{phone,address}})}catch(e){console.error("Profile save error:",e);return res.status(500).json({error:"Unable to save checkout information."})}});
app.get("/api/notifications", requireFirebaseUser, async (req, res) => {
  try {
    const firestore = initFirebase();
    if (!firestore) return res.status(503).json({ error: "Firebase is not configured." });
    const uid = String(req.firebaseUser.uid || "").trim();
    const snapshot = await firestore.collection("notifications").where("uid", "==", uid).get();
    const notifications = snapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
      .slice(0, 100);
    return res.json({ ok: true, notifications });
  } catch (error) {
    console.error("Notification load error:", error);
    return res.status(500).json({ error: "Unable to load notifications." });
  }
});

app.patch("/api/notifications/:notificationId/read", requireFirebaseUser, async (req, res) => {
  try {
    const firestore = initFirebase();
    if (!firestore) return res.status(503).json({ error: "Firebase is not configured." });
    const ref = firestore.collection("notifications").doc(req.params.notificationId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "Notification not found." });
    const notification = snap.data() || {};
    if (String(notification.uid || "") !== String(req.firebaseUser.uid || "")) {
      return res.status(403).json({ error: "You are not allowed to update this notification." });
    }
    const readAt = new Date().toISOString();
    await ref.update({ read: true, readAt });
    return res.json({ ok: true, notification: { id: snap.id, ...notification, read: true, readAt } });
  } catch (error) {
    console.error("Notification read error:", error);
    return res.status(500).json({ error: "Unable to mark notification as read." });
  }
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
async function getMergedProducts({includeHidden=false}={}){
  const base=Array.isArray(catalog)?catalog.map(p=>({...p})):[];
  const firestore=initFirebase();
  const map=new Map(base.map(p=>[String(p.id),p]));
  if(firestore){
    const snap=await firestore.collection('products').get();
    snap.docs.forEach(doc=>{const d=doc.data()||{};const id=String(d.id||doc.id);map.set(id,{...(map.get(id)||{}),...d,id});});
  }
  const list=[...map.values()];
  return includeHidden?list:list.filter(p=>!p.hidden);
}

app.get("/api/catalog", async (_req, res) => {
  try { res.json({products:await getMergedProducts()}); }
  catch(error){ console.error('Catalog error:',error); res.status(500).json({error:'Unable to load product catalogue.'}); }
});

async function findProduct(productId){
  const products=await getMergedProducts({includeHidden:true});
  return products.find(product=>String(product.id)===String(productId));
}

async function buildTrustedItems(items){
  if(!Array.isArray(items)||items.length===0)throw new Error('Cart is empty.');
  const products=await getMergedProducts({includeHidden:true});
  const productMap=new Map(products.map(product=>[String(product.id),product]));
  return items.map(item=>{
    const product=productMap.get(String(item.productId));
    if(!product||product.hidden)throw new Error(`Product not found: ${item.productId}`);
    if(product.comingSoon)throw new Error(`${product.name} is coming soon.`);
    const quantity=Number(item.quantity);
    if(!Number.isInteger(quantity)||quantity<1||quantity>20)throw new Error(`Invalid quantity for ${product.name}.`);
    const stock=Number(product.stock);
    if(Number.isFinite(stock)&&quantity>stock)throw new Error(`${product.name} only has ${stock} left in stock.`);
    const size=String(item.size||'').trim(),color=String(item.color||'').trim();
    if(!size||!color)throw new Error(`Size and colour are required for ${product.name}.`);
    if(!Array.isArray(product.sizes)||!product.sizes.includes(size))throw new Error(`Invalid size for ${product.name}.`);
    if(!Array.isArray(product.colors)||!product.colors.includes(color))throw new Error(`Invalid colour for ${product.name}.`);
    return {productId:product.id,name:product.name,category:product.category,collection:product.collection||'',price:Number(product.price||0),quantity,size,color,lineTotal:Number(product.price||0)*quantity};
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
        userId = "",
        promoCode = ""
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
        await buildTrustedItems(items);

      const subtotal =
        trustedItems.reduce(
          (sum, item) =>
            sum + item.lineTotal,
          0
        );

      let appliedPromo = null;
      let discount = 0;
      const cleanPromoCode = String(promoCode || "").trim().toUpperCase();
      if (cleanPromoCode) {
        const promo = promoCodes.get(cleanPromoCode);
        if (!promo || !promoIsCurrentlyActive(promo)) {
          return res.status(400).json({ error: "Invalid or expired promo code." });
        }
        const promoItems = trustedItems.map(item => ({
          id: item.productId,
          price: item.price,
          quantity: item.quantity,
          collection: item.collection,
          category: item.category
        }));
        const promoResult = promoDiscount(promo, promoItems);
        if (Number(promo.minOrder || 0) > promoResult.eligibleSubtotal) {
          return res.status(400).json({ error: `Minimum eligible order is ₦${Number(promo.minOrder).toLocaleString()}.` });
        }
        discount = Math.min(subtotal, Number(promoResult.discount || 0));
        appliedPromo = { code: promo.code, type: promo.type, value: promo.value, discount, eligibleSubtotal: promoResult.eligibleSubtotal };
      }

      const total = Math.max(0, subtotal - discount);

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

        promo: appliedPromo,

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
        total,
        promo: appliedPromo
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

async function decrementInventoryForOrder(firestore, items){
  if(!firestore||!Array.isArray(items)||!items.length)return;
  await firestore.runTransaction(async transaction=>{
    const refs=items.map(item=>firestore.collection('products').doc(String(item.productId)));
    const snaps=[];
    for(const ref of refs) snaps.push(await transaction.get(ref));
    for(let i=0;i<items.length;i++){
      const item=items[i], ref=refs[i], snap=snaps[i];
      const base=Array.isArray(catalog)?catalog.find(p=>String(p.id)===String(item.productId))||{}:{};
      const current=snap.exists?{...base,...snap.data()}:base;
      const stock=Number(current.stock);
      if(!Number.isFinite(stock)) continue;
      const next=stock-Number(item.quantity||0);
      if(next<0) throw new Error(`${current.name||item.name} is no longer available in the requested quantity.`);
      transaction.set(ref,{id:String(item.productId),stock:next,updatedAt:new Date().toISOString()},{merge:true});
    }
  });
}

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

    if(!existingData.inventoryAdjustedAt){
      await decrementInventoryForOrder(firestore, existingData.items?.length?existingData.items:items);
    }

    const updates = {
      paymentStatus:
        "PAID",

      inventoryAdjustedAt: existingData.inventoryAdjustedAt || new Date().toISOString(),

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

  await decrementInventoryForOrder(firestore, items);

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
      new Date().toISOString(),

    inventoryAdjustedAt:
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

      const previousStatus = String(
        existing.deliveryStatus ||
        existing.delivery?.status ||
        existing.paymentStatus ||
        "PAID"
      ).trim().toUpperCase();

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
        estimatedDelivery: delivery.estimatedDelivery,
        courier: delivery.courier,
        trackingNumber: delivery.trackingNumber,
        deliveryNote: delivery.note,
        updatedAt: now
      });

      const updatedOrder = {
        id: orderSnap.id,
        ...existing,
        deliveryStatus,
        delivery,
        estimatedDelivery: delivery.estimatedDelivery,
        courier: delivery.courier,
        trackingNumber: delivery.trackingNumber,
        deliveryNote: delivery.note,
        updatedAt: now
      };

      if (deliveryStatus !== previousStatus &&
          ["PROCESSING", "SHIPPED", "DELIVERED"].includes(deliveryStatus)) {
        try {
          await createOrderStatusNotification(updatedOrder, deliveryStatus, delivery);
        } catch (notificationError) {
          console.error("Order notification creation error:", notificationError);
        }
        try {
          await sendOrderStatusEmail(updatedOrder, deliveryStatus, delivery);
        } catch (emailError) {
          console.error("Order status email error:", emailError);
        }
      }

      return res.json({
        ok: true,
        order: updatedOrder
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



async function findUserUidByEmail(email){
  const clean=String(email||'').trim().toLowerCase();
  if(!clean)return '';
  try{
    const firestore=initFirebase();
    if(!firestore)return '';
    const snap=await firestore.collection('users').where('email','==',clean).limit(1).get();
    if(!snap.empty)return String(snap.docs[0].id);
  }catch(_){}
  try{
    const record=await admin.auth().getUserByEmail(clean);
    return String(record.uid||'');
  }catch(_){return ''}
}

// ---------- STAYUNKNOWN CUSTOMER SUPPORT / RESTOCK / PROMO ADDITIONS ----------
const supportTickets = new Map();

async function sendSupportEmail(to, subject, intro, ticket){
  const recipient=String(to||'').trim().toLowerCase();
  if(!recipient) return null;
  const replies=Array.isArray(ticket?.replies)?ticket.replies:[];
  const rows=replies.map(r=>`
    <div style="margin:12px 0;padding:12px;border:1px solid #ddd;border-radius:8px">
      <strong>${escapeEmailHtml(r.from||'ADMIN')}</strong>
      <div style="color:#666;font-size:12px;margin-top:4px">${escapeEmailHtml(r.createdAt||'')}</div>
      <p style="margin:8px 0 0;white-space:pre-wrap">${escapeEmailHtml(r.message||'')}</p>
    </div>`).join('');
  const html=`
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;color:#111">
      <h2>${escapeEmailHtml(ticket?.subject||'STAYUNKNOWN SUPPORT')}</h2>
      <p>${escapeEmailHtml(intro||'There is an update on your support ticket.')}</p>
      <p><strong>Ticket:</strong> ${escapeEmailHtml(ticket?.id||'')}</p>
      <p><strong>Order:</strong> ${escapeEmailHtml(ticket?.orderNumber||'None attached')}</p>
      <div style="margin:18px 0;padding:14px;background:#f5f5f5;border-radius:8px">
        <strong>Original request</strong>
        <p style="white-space:pre-wrap">${escapeEmailHtml(ticket?.message||'')}</p>
      </div>
      ${rows}
      <p style="color:#666;font-size:12px">Reply through your STAYUNKNOWN support page to continue the conversation.</p>
    </div>`;
  return sendResendEmail({to:recipient,subject,html});
}

async function createSupportNotification({uid,ticketId,title,message,audience,orderNumber=''}) {
  const firestore=initFirebase();
  if(!firestore || !uid) return null;
  const notification={
    uid:String(uid),
    ticketId:String(ticketId||''),
    title:String(title||'SUPPORT UPDATE'),
    message:String(message||''),
    audience:String(audience||'customer'),
    orderNumber:String(orderNumber||''),
    read:false,
    createdAt:new Date().toISOString()
  };
  const doc=await firestore.collection('notifications').add(notification);
  return {id:doc.id,...notification};
}

async function loadSupportTicket(ticketId){
  const id=String(ticketId||'').trim();
  if(!id) return null;
  const firestore=initFirebase();
  if(firestore){
    const snap=await firestore.collection('supportTickets').doc(id).get();
    if(snap.exists) return {id:snap.id,...snap.data()};
  }
  return supportTickets.get(id)||null;
}

async function saveSupportTicket(ticket){
  const firestore=initFirebase();
  if(firestore){
    await firestore.collection('supportTickets').doc(String(ticket.id)).set(ticket,{merge:true});
  }
  supportTickets.set(String(ticket.id),ticket);
  return ticket;
}

async function listSupportTickets(){
  const firestore=initFirebase();
  if(firestore){
    const snap=await firestore.collection('supportTickets').get();
    return snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>String(b.updatedAt||b.createdAt||'').localeCompare(String(a.updatedAt||a.createdAt||'')));
  }
  return [...supportTickets.values()].sort((a,b)=>String(b.updatedAt||b.createdAt||'').localeCompare(String(a.updatedAt||a.createdAt||'')));
}
const restockSubscriptions = new Map();
const promoCodes = new Map([
  ['MOVEINSILENCE10',{code:'MOVEINSILENCE10',type:'percent',value:10,active:false,startsAt:null,endsAt:null,minOrder:0,maxUses:null,used:0,appliesTo:{type:'store',collection:null,productIds:[]}}],
  ['UNKNOWN10',{code:'UNKNOWN10',type:'percent',value:10,active:false,startsAt:null,endsAt:null,minOrder:0,maxUses:null,used:0,appliesTo:{type:'store',collection:null,productIds:[]}}]
]);

function authenticate(req,res,next){
  requireFirebaseUser(req,res,err=>{
    if(err)return next(err);
    const firebaseUser=req.firebaseUser||{};
    const email=String(firebaseUser.email||'').trim().toLowerCase();
    const isAdmin=getAdminEmails().includes(email);
    req.user={...firebaseUser,isAdmin};
    next();
  });
}

function safeCustomerEmail(req){
  return req.user?.email || req.body?.email || '';
}

app.post('/api/support', authenticate, async (req,res)=>{
  try{
    const {subject='',message='',orderNumber='',attachments=[]}=req.body||{};
    if(!String(message).trim()) return res.status(400).json({error:'Message is required.'});
    const cleanAttachments=Array.isArray(attachments)?attachments.slice(0,2).filter(a=>a&&String(a.dataUrl||'').startsWith('data:image/')).map(a=>({name:String(a.name||'').slice(0,120),type:String(a.type||'').slice(0,80),dataUrl:String(a.dataUrl||'').slice(0,230000)})):[];
    const now=new Date().toISOString();
    const id=`SUP-${Date.now()}-${Math.random().toString(36).slice(2,8).toUpperCase()}`;
    const ticket={
      id,userId:String(req.user.uid||''),uid:String(req.user.uid||''),
      email:safeCustomerEmail(req),
      subject:String(subject).trim().slice(0,120)||'SUPPORT REQUEST',
      message:String(message).trim().slice(0,5000),
      orderNumber:String(orderNumber).trim().slice(0,80),
      attachments:cleanAttachments,replies:[],status:'OPEN',createdAt:now,updatedAt:now
    };
    await saveSupportTicket(ticket);
    const adminEmails=getAdminEmails();
    for(const email of adminEmails) await sendSupportEmail(email,ticket.subject,'A customer created a new support ticket.',ticket).catch(e=>console.error('Support admin email error:',e));
    if(ticket.email) await sendSupportEmail(ticket.email,ticket.subject,'Your STAYUNKNOWN support ticket has been created.',ticket).catch(e=>console.error('Support customer email error:',e));
    await Promise.all(adminEmails.map(async email=>{
      const adminUid=await findUserUidByEmail(email);
      if(adminUid) await createSupportNotification({uid:adminUid,ticketId:id,title:'NEW SUPPORT REQUEST',message:`New support request: ${ticket.subject}`,audience:'admin',orderNumber:ticket.orderNumber}).catch(()=>{});
    }));
    return res.json({ok:true,ticket});
  }catch(e){console.error('Support create error:',e);return res.status(500).json({error:'Unable to create support request.'})}
});

app.get('/api/support', authenticate, async (req,res)=>{
  try{
    const mine=(await listSupportTickets()).filter(t=>String(t.userId||t.uid||'')===String(req.user.uid||''));
    return res.json({tickets:mine});
  }catch(e){console.error('Support list error:',e);return res.status(500).json({error:'Unable to load support requests.'})}
});

app.post('/api/support/:ticketId/reply', authenticate, async (req,res)=>{
  try{
    const ticket=await loadSupportTicket(req.params.ticketId);
    if(!ticket)return res.status(404).json({error:'Support ticket not found.'});
    if(String(ticket.userId||ticket.uid||'')!==String(req.user.uid||''))return res.status(403).json({error:'You are not allowed to reply to this ticket.'});
    if(String(ticket.status||'').toUpperCase()==='CLOSED')return res.status(400).json({error:'This ticket is closed. Create a new ticket if you still need help.'});
    const message=String(req.body?.message||'').trim();
    if(!message)return res.status(400).json({error:'Message is required.'});
    const attachments=Array.isArray(req.body?.attachments)?req.body.attachments.slice(0,2).filter(a=>a&&String(a.dataUrl||'').startsWith('data:image/')).map(a=>({name:String(a.name||'').slice(0,120),type:String(a.type||'').slice(0,80),dataUrl:String(a.dataUrl||'').slice(0,230000)})):[];
    const reply={from:'CUSTOMER',message:message.slice(0,5000),attachments,createdAt:new Date().toISOString()};
    ticket.replies=Array.isArray(ticket.replies)?ticket.replies:[];
    ticket.replies.push(reply);ticket.status='OPEN';ticket.updatedAt=reply.createdAt;
    await saveSupportTicket(ticket);
    for(const email of getAdminEmails()) await sendSupportEmail(email,ticket.subject,'The customer replied to your support ticket.',ticket).catch(e=>console.error('Support admin reply email error:',e));
    for(const email of getAdminEmails()){
      const adminUid=await findUserUidByEmail(email);
      if(adminUid) await createSupportNotification({uid:adminUid,ticketId:ticket.id,title:'SUPPORT TICKET REPLY',message:`Customer replied to: ${ticket.subject}`,audience:'admin',orderNumber:ticket.orderNumber}).catch(()=>{});
    }
    return res.json({ok:true,ticket});
  }catch(e){console.error('Support customer reply error:',e);return res.status(500).json({error:'Unable to send reply.'})}
});

app.post('/api/restock-subscriptions', async (req,res)=>{
  try{
    const {productId,email}=req.body||{};
    if(!String(productId).trim() || !String(email).trim()) return res.status(400).json({error:'Product and email are required.'});
    const key=String(productId);
    const list=restockSubscriptions.get(key)||[];
    if(!list.includes(String(email).trim().toLowerCase())) list.push(String(email).trim().toLowerCase());
    restockSubscriptions.set(key,list);
    res.json({ok:true,subscribed:true});
  }catch(e){res.status(500).json({error:'Unable to save restock notification.'})}
});

function promoIsCurrentlyActive(p){
  const now=Date.now();
  if(!p || !p.active) return false;
  if(p.startsAt && now < Date.parse(p.startsAt)) return false;
  if(p.endsAt && now > Date.parse(p.endsAt)) return false;
  if(p.maxUses!=null && Number(p.used||0)>=Number(p.maxUses)) return false;
  return true;
}

function promoEligibleItems(promo, items){
  const scope=promo?.appliesTo||{type:'store'};
  if(scope.type==='store') return items;
  if(scope.type==='collection'){
    return items.filter(i=>String(i.collection||i.category||'').toLowerCase()===String(scope.collection||'').toLowerCase());
  }
  if(scope.type==='products'){
    const ids=new Set((scope.productIds||[]).map(String));
    return items.filter(i=>ids.has(String(i.id)));
  }
  return [];
}

function promoDiscount(promo, items){
  const eligible=promoEligibleItems(promo,items);
  const eligibleSubtotal=eligible.reduce((s,i)=>s+Number(i.price||0)*Number(i.quantity||1),0);
  if(eligibleSubtotal < Number(promo.minOrder||0)) return {discount:0,eligibleSubtotal};
  const discount=promo.type==='fixed'
    ? Math.min(Number(promo.value||0),eligibleSubtotal)
    : eligibleSubtotal*(Number(promo.value||0)/100);
  return {discount,eligibleSubtotal};
}

app.post('/api/promo/validate', async (req,res)=>{
  const code=String(req.body?.code||'').trim().toUpperCase();
  const items=Array.isArray(req.body?.items)?req.body.items:[];
  const promo=promoCodes.get(code);
  if(!promo || !promoIsCurrentlyActive(promo)) return res.status(404).json({valid:false,error:'Invalid or expired promo code.'});
  const {discount,eligibleSubtotal}=promoDiscount(promo,items);
  if(Number(promo.minOrder||0)>eligibleSubtotal) return res.status(400).json({valid:false,error:`Minimum eligible order is ₦${Number(promo.minOrder).toLocaleString()}.`});
  res.json({valid:true,...promo,discount,eligibleSubtotal});
});

app.post('/api/admin/promos', authenticate, async (req,res)=>{
  if(!req.user?.isAdmin) return res.status(403).json({error:'Admin only.'});
  const body=req.body||{};
  const code=String(body.code||'').trim().toUpperCase();
  const type=body.type==='fixed'?'fixed':'percent';
  const value=Number(body.value);
  const scope=body.appliesTo||{type:'store'};
  if(!code || !Number.isFinite(value) || value<=0 || (type==='percent' && value>100)) return res.status(400).json({error:'Invalid promo.'});
  if(!['store','collection','products'].includes(scope.type)) return res.status(400).json({error:'Invalid promo scope.'});
  if(scope.type==='collection' && !String(scope.collection||'').trim()) return res.status(400).json({error:'Collection is required.'});
  if(scope.type==='products' && !Array.isArray(scope.productIds)) return res.status(400).json({error:'Product IDs are required.'});
  const promo={
    code,type,value,active:body.active!==false,
    startsAt:body.startsAt||null,endsAt:body.endsAt||null,
    minOrder:Math.max(0,Number(body.minOrder||0)),
    maxUses:body.maxUses==null||body.maxUses===''?null:Math.max(1,Number(body.maxUses)),
    used:0,
    appliesTo:{
      type:scope.type,
      collection:scope.type==='collection'?String(scope.collection):null,
      productIds:scope.type==='products'?[...new Set(scope.productIds.map(String))]:[]
    }
  };
  promoCodes.set(code,promo);
  res.json({ok:true,promo});
});

app.patch('/api/admin/promos/:code', authenticate, async (req,res)=>{
  if(!req.user?.isAdmin) return res.status(403).json({error:'Admin only.'});
  const code=String(req.params.code||'').toUpperCase();
  const existing=promoCodes.get(code);
  if(!existing) return res.status(404).json({error:'Promo not found.'});
  const next={...existing,...(req.body||{}),code};
  if(req.body?.appliesTo) next.appliesTo={...existing.appliesTo,...req.body.appliesTo};
  promoCodes.set(code,next);
  res.json({ok:true,promo:next});
});

app.delete('/api/admin/promos/:code', authenticate, async (req,res)=>{
  if(!req.user?.isAdmin) return res.status(403).json({error:'Admin only.'});
  const code=String(req.params.code||'').toUpperCase();
  promoCodes.delete(code);
  res.json({ok:true});
});

app.get('/api/admin/promos', authenticate, async (req,res)=>{
  if(!req.user?.isAdmin) return res.status(403).json({error:'Admin only.'});
  res.json({promos:[...promoCodes.values()].map(p=>({...p,isCurrentlyActive:promoIsCurrentlyActive(p)}))});
});

app.get('/api/admin/inventory', authenticate, async (req,res)=>{
  if(!req.user?.isAdmin) return res.status(403).json({error:'Admin only.'});
  try{
    const items=Array.isArray(catalog)?catalog.map(p=>({
      id:p.id,name:p.name,category:p.category,stock:Number(p.stock??0),
      lowStockThreshold:Number(p.lowStockThreshold??3),comingSoon:!!p.comingSoon
    })):[];
    res.json({items});
  }catch(e){res.status(500).json({error:'Unable to load inventory.'})}
});

app.get('/api/admin/restock-subscriptions', authenticate, async (req,res)=>{
  if(!req.user?.isAdmin) return res.status(403).json({error:'Admin only.'});
  const subscriptions={};
  for(const [productId,emails] of restockSubscriptions.entries()){
    subscriptions[String(productId)]=Array.isArray(emails)?emails:[];
  }
  res.json({subscriptions});
});

app.get('/api/admin/support', authenticate, async (req,res)=>{
  if(!req.user?.isAdmin) return res.status(403).json({error:'Admin only.'});
  try{return res.json({tickets:await listSupportTickets()});}
  catch(e){console.error('Admin support list error:',e);return res.status(500).json({error:'Unable to load support requests.'})}
});

app.post('/api/admin/support/:ticketId/reply', authenticate, async (req,res)=>{
  try{
    if(!req.user?.isAdmin) return res.status(403).json({error:'Admin only.'});
    const ticket=await loadSupportTicket(req.params.ticketId);
    if(!ticket)return res.status(404).json({error:'Support ticket not found.'});
    if(String(ticket.status||'').toUpperCase()==='CLOSED')return res.status(400).json({error:'This ticket is closed.'});
    const message=String(req.body?.message||'').trim();
    if(!message)return res.status(400).json({error:'Message is required.'});
    const attachments=Array.isArray(req.body?.attachments)?req.body.attachments.slice(0,2).filter(a=>a&&String(a.dataUrl||'').startsWith('data:image/')).map(a=>({name:String(a.name||'').slice(0,120),type:String(a.type||'').slice(0,80),dataUrl:String(a.dataUrl||'').slice(0,230000)})):[];
    const reply={from:'ADMIN',message:message.slice(0,5000),attachments,createdAt:new Date().toISOString(),adminEmail:String(req.user.email||'').trim().toLowerCase()};
    ticket.replies=Array.isArray(ticket.replies)?ticket.replies:[];
    ticket.replies.push(reply);ticket.status='OPEN';ticket.updatedAt=reply.createdAt;
    await saveSupportTicket(ticket);
    if(ticket.email) await sendSupportEmail(ticket.email,ticket.subject,'STAYUNKNOWN has replied to your support ticket.',ticket).catch(e=>console.error('Support customer reply email error:',e));
    await createSupportNotification({uid:String(ticket.userId||ticket.uid||''),ticketId:ticket.id,title:'SUPPORT TICKET REPLY',message:'STAYUNKNOWN replied to your support ticket.',audience:'customer',orderNumber:ticket.orderNumber}).catch(()=>{});
    return res.json({ok:true,ticket});
  }catch(e){console.error('Support admin reply error:',e);return res.status(500).json({error:'Unable to send reply.'})}
});

app.patch('/api/admin/support/:ticketId/status', authenticate, async (req,res)=>{
  try{
    if(!req.user?.isAdmin) return res.status(403).json({error:'Admin only.'});
    const ticket=await loadSupportTicket(req.params.ticketId);
    if(!ticket)return res.status(404).json({error:'Support ticket not found.'});
    const status=String(req.body?.status||'OPEN').trim().toUpperCase();
    if(!['OPEN','CLOSED'].includes(status))return res.status(400).json({error:'Invalid ticket status.'});
    ticket.status=status;ticket.updatedAt=new Date().toISOString();
    await saveSupportTicket(ticket);
    if(ticket.userId) await createSupportNotification({uid:String(ticket.userId),ticketId:ticket.id,title:`SUPPORT TICKET ${status}`,message:`Your support ticket is now ${status.toLowerCase()}.`,audience:'customer',orderNumber:ticket.orderNumber}).catch(()=>{});
    return res.json({ok:true,ticket});
  }catch(e){console.error('Support status error:',e);return res.status(500).json({error:'Unable to update ticket.'})}
});

app.get('/api/admin/notifications', authenticate, async (req,res)=>{
  if(!req.user?.isAdmin) return res.status(403).json({error:'Admin only.'});
  try{
    const firestore=initFirebase();
    if(!firestore)return res.status(503).json({error:'Firebase is not configured.'});
    const adminUids=await Promise.all(getAdminEmails().map(findUserUidByEmail));
    const uidSet=new Set(adminUids.filter(Boolean));
    const snapshot=await firestore.collection('notifications').get();
    const notifications=snapshot.docs.map(d=>({id:d.id,...d.data()})).filter(n=>String(n.audience||'')==='admin'||uidSet.has(String(n.uid||''))).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''))).slice(0,100);
    return res.json({ok:true,notifications});
  }catch(e){console.error('Admin notification load error:',e);return res.status(500).json({error:'Unable to load notifications.'})}
});

app.patch('/api/admin/notifications/:notificationId/read', authenticate, async (req,res)=>{
  if(!req.user?.isAdmin) return res.status(403).json({error:'Admin only.'});
  try{
    const firestore=initFirebase();
    if(!firestore)return res.status(503).json({error:'Firebase is not configured.'});
    const ref=firestore.collection('notifications').doc(req.params.notificationId);
    const snap=await ref.get();
    if(!snap.exists)return res.status(404).json({error:'Notification not found.'});
    const n=snap.data()||{};
    const adminUids=new Set((await Promise.all(getAdminEmails().map(findUserUidByEmail))).filter(Boolean).map(String));
    if(String(n.audience||'')!=='admin'&&!adminUids.has(String(n.uid||'')))return res.status(403).json({error:'You are not allowed to update this notification.'});
    const readAt=new Date().toISOString();
    await ref.update({read:true,readAt});
    return res.json({ok:true,notification:{id:snap.id,...n,read:true,readAt}});
  }catch(e){console.error('Admin notification read error:',e);return res.status(500).json({error:'Unable to mark notification as read.'})}
});

// ---------- STAYUNKNOWN PRODUCT + COLLECTION MANAGER ----------
async function requireAdminUser(req,res){
  if(!req.user?.isAdmin){res.status(403).json({error:'Admin only.'});return false;}
  const firestore=initFirebase();
  if(!firestore){res.status(503).json({error:'Firebase is not configured.'});return false;}
  return firestore;
}

app.get('/api/admin/products', authenticate, async (req,res)=>{
  try{const firestore=await requireAdminUser(req,res);if(!firestore)return;res.json({products:await getMergedProducts({includeHidden:true})});}
  catch(e){console.error('Admin products load error:',e);res.status(500).json({error:'Unable to load products.'})}
});

function cleanProductPayload(body,id){
  const p=body||{};
  return {
    id:String(id||p.id||'').trim(),name:String(p.name||'').trim().slice(0,180),price:Number(p.price||0),image:String(p.image||'').trim(),description:String(p.description||'').trim().slice(0,3000),category:String(p.category||'').trim().slice(0,100),collection:String(p.collection||'').trim().slice(0,120),stock:Math.max(0,Math.floor(Number(p.stock||0))),lowStockThreshold:Math.max(0,Math.floor(Number(p.lowStockThreshold??3))),sizes:Array.isArray(p.sizes)?p.sizes.map(String).map(x=>x.trim()).filter(Boolean).slice(0,30):[],colors:Array.isArray(p.colors)?p.colors.map(String).map(x=>x.trim()).filter(Boolean).slice(0,30):[],tags:String(p.tags||'').trim().slice(0,500),drop:Boolean(p.drop),comingSoon:Boolean(p.comingSoon),hidden:Boolean(p.hidden),updatedAt:new Date().toISOString()
  };
}

app.post('/api/admin/products', authenticate, async (req,res)=>{
  try{const firestore=await requireAdminUser(req,res);if(!firestore)return;const p=cleanProductPayload(req.body,req.body?.id||`product-${Date.now()}`);if(!p.name||!p.category||!Number.isFinite(p.price)||p.price<0)return res.status(400).json({error:'Name, category and valid price are required.'});const ref=firestore.collection('products').doc(p.id);if((await ref.get()).exists)return res.status(409).json({error:'Product ID already exists.'});await ref.set(p);res.json({ok:true,product:p});}
  catch(e){console.error('Create product error:',e);res.status(500).json({error:'Unable to create product.'})}
});

app.patch('/api/admin/products/:id', authenticate, async (req,res)=>{
  try{const firestore=await requireAdminUser(req,res);if(!firestore)return;const id=String(req.params.id||'').trim();const ref=firestore.collection('products').doc(id);const snap=await ref.get();const base=await findProduct(id);if(!base&&!snap.exists)return res.status(404).json({error:'Product not found.'});const p=cleanProductPayload({...base,...(snap.exists?snap.data():{}),...(req.body||{})},id);await ref.set(p,{merge:true});res.json({ok:true,product:p});}
  catch(e){console.error('Update product error:',e);res.status(500).json({error:'Unable to update product.'})}
});

app.get('/api/collections', async (_req,res)=>{
  try{
    const products=await getMergedProducts();
    const firestore=initFirebase();
    const explicit=[];
    if(firestore){const snap=await firestore.collection('collections').get();snap.docs.forEach(d=>explicit.push({id:d.id,...d.data()}));}
    const map=new Map(explicit.filter(c=>!c.hidden).map(c=>[String(c.name).toLowerCase(),c]));
    for(const p of products){const name=String(p.collection||'').trim();if(!name)continue;const key=name.toLowerCase();if(!map.has(key))map.set(key,{id:`derived-${encodeURIComponent(name).replace(/%/g,'')}`,name,image:'',description:'',order:9999,hidden:false});}
    const list=[...map.values()].map(c=>({...c,productCount:products.filter(p=>String(p.collection||'').toLowerCase()===String(c.name||'').toLowerCase()).length})).filter(c=>c.productCount>0).sort((a,b)=>Number(a.order||0)-Number(b.order||0)||String(a.name).localeCompare(String(b.name)));
    res.json({collections:list});
  }catch(e){console.error('Collections load error:',e);res.status(500).json({error:'Unable to load collections.'})}
});

app.get('/api/admin/collections', authenticate, async (req,res)=>{
  try{const firestore=await requireAdminUser(req,res);if(!firestore)return;const products=await getMergedProducts({includeHidden:true});const snap=await firestore.collection('collections').get();const explicit=snap.docs.map(d=>({id:d.id,...d.data()}));const map=new Map(explicit.map(c=>[String(c.name).toLowerCase(),c]));for(const p of products){const name=String(p.collection||'').trim();if(name&&!map.has(name.toLowerCase()))map.set(name.toLowerCase(),{id:`derived-${encodeURIComponent(name)}`,name,image:'',description:'',order:9999,hidden:false,derived:true});}res.json({collections:[...map.values()].sort((a,b)=>Number(a.order||0)-Number(b.order||0)||String(a.name).localeCompare(String(b.name)))});}
  catch(e){console.error('Admin collections load error:',e);res.status(500).json({error:'Unable to load collections.'})}
});

app.post('/api/admin/collections', authenticate, async (req,res)=>{
  try{const firestore=await requireAdminUser(req,res);if(!firestore)return;const name=String(req.body?.name||'').trim().slice(0,120);if(!name)return res.status(400).json({error:'Collection name is required.'});const id=`col-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;const collection={name,image:String(req.body?.image||'').trim(),description:String(req.body?.description||'').trim().slice(0,1000),order:Math.max(0,Number(req.body?.order||0)),hidden:false,limited:Boolean(req.body?.limited),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};await firestore.collection('collections').doc(id).set(collection);if(Array.isArray(req.body?.productIds))await assignProductsToCollection(firestore,name,req.body.productIds);res.json({ok:true,collection:{id,...collection}});}
  catch(e){console.error('Create collection error:',e);res.status(500).json({error:'Unable to create collection.'})}
});

async function assignProductsToCollection(firestore,name,productIds){
  const ids=new Set((Array.isArray(productIds)?productIds:[]).map(String));
  const products=await getMergedProducts({includeHidden:true});
  const batch=firestore.batch();
  for(const p of products){const ref=firestore.collection('products').doc(String(p.id));if(ids.has(String(p.id)))batch.set(ref,{id:String(p.id),collection:name,updatedAt:new Date().toISOString()},{merge:true});else if(String(p.collection||'').toLowerCase()===String(name).toLowerCase())batch.set(ref,{id:String(p.id),collection:'',updatedAt:new Date().toISOString()},{merge:true});}
  await batch.commit();
}

app.patch('/api/admin/collections/:id', authenticate, async (req,res)=>{
  try{const firestore=await requireAdminUser(req,res);if(!firestore)return;const id=String(req.params.id||'');const ref=firestore.collection('collections').doc(id);const snap=await ref.get();const old=snap.exists?(snap.data()||{}):{};const name=String(req.body?.name||old.name||'').trim().slice(0,120);if(!name)return res.status(400).json({error:'Collection name is required.'});if(!snap.exists && !id.startsWith('derived-'))return res.status(404).json({error:'Collection not found.'});const next={...old,name,image:req.body?.image!==undefined?String(req.body.image||'').trim():old.image||'',description:req.body?.description!==undefined?String(req.body.description||'').trim().slice(0,1000):old.description||'',order:req.body?.order!==undefined?Math.max(0,Number(req.body.order||0)):Number(old.order||0),hidden:req.body?.hidden!==undefined?Boolean(req.body.hidden):Boolean(old.hidden),limited:req.body?.limited!==undefined?Boolean(req.body.limited):Boolean(old.limited),updatedAt:new Date().toISOString()};const targetId=snap.exists?id:`col-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;await firestore.collection('collections').doc(targetId).set(next,{merge:true});if(Array.isArray(req.body?.productIds))await assignProductsToCollection(firestore,name,req.body.productIds);res.json({ok:true,collection:{id:targetId,...next}});}
  catch(e){console.error('Update collection error:',e);res.status(500).json({error:'Unable to update collection.'})}
});

