const { Expo } = require("expo-server-sdk");

const expo = new Expo();

async function sendExpoPushNotifications({
  firestore,
  uid,
  title,
  body,
  data = {},
}) {
  if (!firestore || !uid) return;

  const userRef = firestore.collection("users").doc(String(uid));
  const snap = await userRef.get();
  if (!snap.exists) return;

  const user = snap.data() || {};
  const tokens = Array.isArray(user.expoPushTokens)
    ? [...new Set(user.expoPushTokens.map(String).filter(Boolean))]
    : [];

  const validTokens = tokens.filter((token) => Expo.isExpoPushToken(token));
  if (!validTokens.length) return;

  const messages = validTokens.map((to) => ({
    to,
    sound: "default",
    title: String(title || "STAYUNKNOWN"),
    body: String(body || ""),
    data: data && typeof data === "object" ? data : {},
  }));

  for (const chunk of expo.chunkPushNotifications(messages)) {
    try {
      await expo.sendPushNotificationsAsync(chunk);
    } catch (error) {
      console.error("Expo push send error:", error);
    }
  }
}

module.exports = { expo, sendExpoPushNotifications };
