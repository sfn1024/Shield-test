import { connectLambda, getStore } from "@netlify/blobs";

const STORE_NAME = "sealed-messages";
const MAX_MESSAGE_BYTES = 24 * 1024;
const MAX_MESSAGES = 500;
const ROOM_RE = /^[A-Za-z0-9_-]{22,96}$/;
const ID_RE = /^[A-Za-z0-9_-]{16,96}$/;

const headers = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

const json = (body, statusCode = 200) => ({
  statusCode,
  headers,
  body: JSON.stringify(body)
});

const fail = (status, error) => json({ error }, status);

function validEnvelope(message) {
  if (!message || typeof message !== "object") return false;
  if (message.v !== 1) return false;
  if (!ID_RE.test(String(message.id || ""))) return false;
  if (typeof message.sentAt !== "number" || !Number.isFinite(message.sentAt)) return false;
  if (typeof message.iv !== "string" || message.iv.length < 12 || message.iv.length > 128) return false;
  if (typeof message.ct !== "string" || message.ct.length < 16 || message.ct.length > MAX_MESSAGE_BYTES) return false;
  return true;
}

export const handler = async (event) => {
  try {
    return await handleRelay(event);
  } catch (error) {
    console.error("relay_error", error);
    return fail(500, "Relay crashed. Check Netlify function logs.");
  }
};

async function handleRelay(event) {
  const roomId = event.queryStringParameters?.roomId || "";

  if (!ROOM_RE.test(roomId)) return fail(400, "Invalid room.");

  if (event.blobs) connectLambda(event);
  const store = getStore(STORE_NAME, { consistency: "strong" });

  if (event.httpMethod === "GET") {
    const prefix = `${roomId}/`;
    const listed = await store.list({ prefix });
    const blobs = listed.blobs
      .sort((a, b) => String(a.key).localeCompare(String(b.key)))
      .slice(-MAX_MESSAGES);

    const messages = [];
    for (const blob of blobs) {
      const value = await store.get(blob.key, { type: "json" });
      if (value && validEnvelope(value)) messages.push(value);
    }

    return json({ messages });
  }

  if (event.httpMethod === "POST") {
    const raw = event.body || "";
    if (raw.length > MAX_MESSAGE_BYTES + 4096) return fail(413, "Message is too large.");

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      return fail(400, "Invalid JSON.");
    }

    const message = body?.message;
    if (!validEnvelope(message)) return fail(400, "Invalid message.");

    const key = `${roomId}/${String(message.sentAt).padStart(16, "0")}-${message.id}.json`;
    await store.setJSON(key, message, {
      metadata: { roomId, messageId: message.id }
    });

    return json({ ok: true });
  }

  return fail(405, "Method not allowed.");
}
