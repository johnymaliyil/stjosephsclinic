const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

const WHATSAPP_TOKEN = defineSecret("WHATSAPP_TOKEN");
const WHATSAPP_PHONE_NUMBER_ID = defineSecret("WHATSAPP_PHONE_NUMBER_ID");

const GRAPH_VERSION = "v21.0";
const SEND_CHUNK_SIZE = 20;
const DELAY_BETWEEN_CHUNKS_MS = 1000;

// Patient phone numbers are stored as plain 10-digit Indian mobile numbers
// (no country code); the Cloud API needs a full country-code-prefixed number.
function normalizePhone(raw) {
  let digits = String(raw || "").replace(/[^0-9]/g, "");
  if (digits.length === 10) digits = "91" + digits;
  else if (digits.length === 11 && digits.startsWith("0")) digits = "91" + digits.slice(1);
  return digits;
}

async function collectAllPatientPhones() {
  const phones = new Set();
  const snap = await db.collection("patients").select("phone").get();
  snap.forEach((doc) => {
    const p = normalizePhone(doc.get("phone"));
    if (p.length >= 11) phones.add(p);
  });
  return Array.from(phones);
}

async function sendTemplateMessage(url, token, to, templateName, languageCode, bodyParams) {
  const body = {
    messaging_product: "whatsapp",
    to,
    type: "template",
    template: {
      name: templateName,
      language: { code: languageCode },
      components: bodyParams.length
        ? [{ type: "body", parameters: bodyParams.map((text) => ({ type: "text", text })) }]
        : [],
    },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((json.error && json.error.message) || `HTTP ${res.status}`);
  }
  return json;
}

exports.sendWhatsAppCampaign = onCall(
  { secrets: [WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID], timeoutSeconds: 540, memory: "256MiB" },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Admin login required.");
    }
    const data = request.data || {};
    const templateName = String(data.templateName || "").trim();
    if (!templateName) {
      throw new HttpsError("invalid-argument", "templateName is required.");
    }
    const languageCode = String(data.templateLanguage || "en_US").trim() || "en_US";
    const bodyParams = Array.isArray(data.bodyParams) ? data.bodyParams.map(String) : [];
    const audience = data.audience === "custom" ? "custom" : "all";

    let recipients;
    if (audience === "custom") {
      const phones = Array.isArray(data.phones) ? data.phones : [];
      recipients = Array.from(new Set(phones.map(normalizePhone).filter((p) => p.length >= 11)));
      if (!recipients.length) {
        throw new HttpsError("invalid-argument", "Provide at least one valid phone number.");
      }
    } else {
      recipients = await collectAllPatientPhones();
      if (!recipients.length) {
        throw new HttpsError("failed-precondition", "No patients with a phone number on file.");
      }
    }

    const token = WHATSAPP_TOKEN.value();
    const phoneNumberId = WHATSAPP_PHONE_NUMBER_ID.value();
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;

    let successCount = 0;
    const failures = [];
    for (let i = 0; i < recipients.length; i += SEND_CHUNK_SIZE) {
      const batch = recipients.slice(i, i + SEND_CHUNK_SIZE);
      const results = await Promise.allSettled(
        batch.map((to) => sendTemplateMessage(url, token, to, templateName, languageCode, bodyParams))
      );
      results.forEach((r, idx) => {
        if (r.status === "fulfilled") successCount++;
        else failures.push({ phone: batch[idx], error: String((r.reason && r.reason.message) || r.reason) });
      });
      if (i + SEND_CHUNK_SIZE < recipients.length) {
        await new Promise((resolve) => setTimeout(resolve, DELAY_BETWEEN_CHUNKS_MS));
      }
    }

    const now = new Date();
    await db.collection("whatsappCampaigns").add({
      templateName,
      templateLanguage: languageCode,
      bodyParams,
      audience,
      totalRecipients: recipients.length,
      successCount,
      failCount: failures.length,
      failures: failures.slice(0, 20),
      createdAt: now.toISOString(),
      createdAtMillis: now.getTime(),
      createdBy: (request.auth.token && request.auth.token.email) || request.auth.uid,
    });

    return {
      totalRecipients: recipients.length,
      successCount,
      failCount: failures.length,
      failures: failures.slice(0, 10),
    };
  }
);
