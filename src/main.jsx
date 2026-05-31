import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const enc = new TextEncoder();
const dec = new TextDecoder();
const KDF = { name: "PBKDF2", hash: "SHA-256", iterations: 650000 };
const RELAY = "/.netlify/functions/relay";
const POLL_MS = 1800;

const toB64Url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const fromB64Url = (value) => {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
};

const randomId = (bytes = 16) => toB64Url(crypto.getRandomValues(new Uint8Array(bytes)));
const byTime = (a, b) => a.ts - b.ts || a.id.localeCompare(b.id);

async function sha256(bytes) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

async function fingerprint(roomId, salt) {
  const hash = await sha256(enc.encode(`${roomId}.${salt}`));
  const hex = [...hash.slice(0, 5)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `${hex.slice(0, 5)}-${hex.slice(5, 10)}`;
}

async function deriveKey(passphrase, salt) {
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: KDF.name, hash: KDF.hash, iterations: KDF.iterations, salt: fromB64Url(salt) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptMessage(key, roomId, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = enc.encode(JSON.stringify(payload));
  const aad = enc.encode(`sealed:v1:${roomId}`);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, encoded);
  return { v: 1, id: payload.id, sentAt: payload.ts, iv: toB64Url(iv), ct: toB64Url(ct) };
}

async function decryptMessage(key, roomId, envelope) {
  const aad = enc.encode(`sealed:v1:${roomId}`);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromB64Url(envelope.iv), additionalData: aad },
    key,
    fromB64Url(envelope.ct)
  );
  return JSON.parse(dec.decode(pt));
}

function parseInvite() {
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const roomId = params.get("room");
  const salt = params.get("salt");
  if (roomId && salt) return { roomId, salt };
  return null;
}

function inviteUrl(roomId, salt) {
  const url = new URL(window.location.href);
  url.hash = new URLSearchParams({ room: roomId, salt }).toString();
  return url.toString();
}

function App() {
  const [screen, setScreen] = useState("setup");
  const [name, setName] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [invite, setInvite] = useState(() => parseInvite());
  const [inviteText, setInviteText] = useState(() => {
    const parsed = parseInvite();
    return parsed ? inviteUrl(parsed.roomId, parsed.salt) : "";
  });
  const [room, setRoom] = useState(null);
  const [key, setKey] = useState(null);
  const [deviceId, setDeviceId] = useState(() => randomId(12));
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState("");
  const [notice, setNotice] = useState("");
  const [relayState, setRelayState] = useState("idle");
  const [fp, setFp] = useState("");
  const seen = useRef(new Set());
  const relayMissing = useRef(false);
  const bottom = useRef(null);

  const canUnlock = name.trim().length > 0 && passphrase.length >= 12;
  const shareLink = useMemo(() => (room ? inviteUrl(room.roomId, room.salt) : ""), [room]);

  useEffect(() => {
    if (!room) return;
    fingerprint(room.roomId, room.salt).then(setFp).catch(() => setFp("-----"));
  }, [room]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);

  useEffect(() => {
    if (!room || !key) return undefined;
    let alive = true;

    async function poll() {
      if (relayMissing.current) return;
      try {
        const res = await fetch(`${RELAY}?roomId=${encodeURIComponent(room.roomId)}`, { cache: "no-store" });
        if (res.status === 404) {
          relayMissing.current = true;
          setRelayState("offline");
          setNotice("Relay function is not deployed on this Netlify site. Redeploy with netlify/functions included.");
          return;
        }
        if (!res.ok) throw new Error("Relay unavailable.");
        const data = await res.json();
        const incoming = [];
        for (const envelope of data.messages || []) {
          if (seen.current.has(envelope.id)) continue;
          try {
            const payload = await decryptMessage(key, room.roomId, envelope);
            if (!payload || typeof payload.text !== "string") continue;
            seen.current.add(envelope.id);
            incoming.push(payload);
          } catch {
            setNotice("A message failed authentication and was ignored.");
          }
        }
        if (incoming.length && alive) {
          setMessages((prev) => [...prev, ...incoming].sort(byTime));
        }
        if (alive) setRelayState("live");
      } catch {
        if (alive) setRelayState("offline");
      }
    }

    poll();
    const timer = window.setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [room, key]);

  async function unlock(nextRoom) {
    if (!canUnlock) {
      setNotice("Use a name and a shared passphrase of at least 12 characters.");
      return;
    }

    try {
      const derived = await deriveKey(passphrase, nextRoom.salt);
      setRoom(nextRoom);
      setKey(derived);
      setScreen("chat");
      setNotice("");
      window.history.replaceState(null, "", `#${new URLSearchParams({ room: nextRoom.roomId, salt: nextRoom.salt })}`);
    } catch {
      setNotice("This browser could not unlock encryption.");
    }
  }

  async function createRoom() {
    const nextRoom = { roomId: randomId(18), salt: randomId(16) };
    setInvite(nextRoom);
    setInviteText(inviteUrl(nextRoom.roomId, nextRoom.salt));
    await unlock(nextRoom);
  }

  async function joinRoom() {
    if (!invite) {
      setNotice("Paste an invite link first, or create a new room.");
      return;
    }
    await unlock(invite);
  }

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(shareLink);
      setNotice("Invite copied. Share it with only one person.");
    } catch {
      setNotice("Copy failed. Select the invite link manually.");
    }
  }

  async function sendMessage() {
    const clean = text.trim();
    if (!clean || !room || !key) return;
    const payload = {
      id: randomId(18),
      senderId: deviceId,
      senderName: name.trim(),
      text: clean,
      ts: Date.now()
    };

    setText("");
    seen.current.add(payload.id);
    setMessages((prev) => [...prev, payload].sort(byTime));

    try {
      const message = await encryptMessage(key, room.roomId, payload);
      const res = await fetch(`${RELAY}?roomId=${encodeURIComponent(room.roomId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message })
      });
      if (res.status === 404) {
        relayMissing.current = true;
        throw new Error("Relay function is not deployed.");
      }
      if (!res.ok) throw new Error("Send failed.");
      setRelayState("live");
      setNotice("");
    } catch {
      setRelayState("offline");
      setNotice("Message is encrypted locally, but the relay did not receive it. Keep this tab open and try again.");
    }
  }

  function lock() {
    setScreen("setup");
    setRoom(null);
    setKey(null);
    setPassphrase("");
    setMessages([]);
    setText("");
    setFp("");
    setRelayState("idle");
    setDeviceId(randomId(12));
    seen.current = new Set();
    relayMissing.current = false;
  }

  return (
    <main className="shell" aria-label="Sealed encrypted chat">
      <header className="topbar">
        <div className="brand" aria-label="Sealed">
          <span className="mark" aria-hidden="true">S</span>
          <span>
            <strong>Sealed</strong>
            <small>two-person encrypted relay</small>
          </span>
        </div>
        {screen === "chat" && (
          <div className="status">
            <span className={`pulse ${relayState}`} aria-hidden="true" />
            <span>{relayState === "live" ? "live" : relayState === "offline" ? "retrying" : "opening"}</span>
            <span className="fingerprint">#{fp}</span>
            <button className="ghost" onClick={lock}>Lock</button>
          </div>
        )}
      </header>

      {screen === "setup" ? (
        <section className="setup">
          <div className="intro">
            <p className="eyebrow">No accounts. No database. No plaintext on the relay.</p>
            <h1>Instant private text for exactly two people.</h1>
            <p>
              Messages are encrypted before they leave this browser. Netlify only carries ciphertext, and the
              passphrase never leaves your device.
            </p>
          </div>

          <div className="panel">
            <label>
              Your display name
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoComplete="off" />
            </label>
            <label>
              Shared passphrase
              <input
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                type="password"
                autoComplete="off"
                placeholder="12+ characters, agreed outside this app"
              />
            </label>
            <label>
              Invite link
              <textarea
                value={inviteText}
                onChange={(e) => {
                  setInviteText(e.target.value);
                  setInvite(parseInviteFromText(e.target.value));
                }}
                placeholder="Paste an invite link here to join"
                rows={3}
              />
            </label>
            <div className="actions">
              <button className="secondary" onClick={joinRoom}>Join invite</button>
              <button className="primary" onClick={createRoom}>Create room</button>
            </div>
            <p className="fineprint">
              Lose the passphrase and the chat is unrecoverable. A weak passphrase weakens the whole room.
            </p>
            {notice && <p className="notice" role="alert">{notice}</p>}
          </div>
        </section>
      ) : (
        <section className="chat">
          <aside className="roomcard">
            <div>
              <span className="label">Room fingerprint</span>
              <strong>#{fp}</strong>
            </div>
            <button className="secondary" onClick={copyInvite}>Copy invite</button>
            <input className="invite" value={shareLink} readOnly aria-label="Invite link" />
          </aside>

          <div className="stream" aria-live="polite">
            {messages.length === 0 ? (
              <div className="empty">
                <strong>Ready.</strong>
                <span>Send the invite to one person, then write the first encrypted message.</span>
              </div>
            ) : (
              messages.map((message) => (
                <article className={`message ${message.senderId === deviceId ? "mine" : "theirs"}`} key={message.id}>
                  <div className="meta">
                    <span>{message.senderName}</span>
                    <time>{new Date(message.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                  </div>
                  <p>{message.text}</p>
                </article>
              ))
            )}
            <div ref={bottom} />
          </div>

          {notice && <p className="notice chatnotice" role="status">{notice}</p>}

          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              sendMessage();
            }}
          >
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              placeholder="Write a text message..."
              rows={1}
              aria-label="Message"
            />
            <button className="send" disabled={!text.trim()} aria-label="Send message">Send</button>
          </form>
        </section>
      )}
    </main>
  );
}

function parseInviteFromText(value) {
  try {
    const hash = value.includes("#") ? new URL(value).hash : value;
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    const roomId = params.get("room");
    const salt = params.get("salt");
    if (roomId && salt) return { roomId, salt };
  } catch {
    return null;
  }
  return null;
}

createRoot(document.getElementById("root")).render(<App />);
