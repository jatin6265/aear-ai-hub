const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

async function deriveAesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function deriveHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function resolveSecret(name: string): string {
  const value = Deno.env.get(name) ?? "";
  if (!value.trim()) {
    throw new Error(`${name} is not configured`);
  }
  return value.trim();
}

export type EncryptedPayload = {
  algorithm: "AES-256-GCM";
  keyVersion: string;
  iv: string;
  ciphertext: string;
  authTag?: string | null;
};

export async function encryptJson(payload: unknown): Promise<EncryptedPayload> {
  const secret = resolveSecret("CREDENTIAL_ENCRYPTION_KEY");
  const keyVersion = (Deno.env.get("CREDENTIAL_ENCRYPTION_KEY_VERSION") ?? "v1").trim() || "v1";
  const key = await deriveAesKey(secret);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = textEncoder.encode(JSON.stringify(payload ?? {}));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);

  return {
    algorithm: "AES-256-GCM",
    keyVersion,
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
    authTag: null,
  };
}

export async function decryptJson(payload: {
  iv: string;
  ciphertext: string;
}): Promise<unknown> {
  const secret = resolveSecret("CREDENTIAL_ENCRYPTION_KEY");
  const key = await deriveAesKey(secret);

  const iv = base64ToBytes(payload.iv);
  const ciphertext = base64ToBytes(payload.ciphertext);

  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
  return JSON.parse(textDecoder.decode(decrypted));
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function signState(payload: Record<string, unknown>): Promise<string> {
  const secret = resolveSecret("OAUTH_STATE_SIGNING_KEY");
  const key = await deriveHmacKey(secret);
  const json = JSON.stringify(payload);
  const body = bytesToBase64(textEncoder.encode(json));
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder.encode(body));
  const sig = bytesToBase64(new Uint8Array(signature));
  return `${body}.${sig}`;
}

export async function verifyState(token: string): Promise<Record<string, unknown>> {
  const secret = resolveSecret("OAUTH_STATE_SIGNING_KEY");
  const key = await deriveHmacKey(secret);

  const [body, sig] = token.split(".");
  if (!body || !sig) {
    throw new Error("Invalid state token format");
  }

  const ok = await crypto.subtle.verify("HMAC", key, base64ToBytes(sig), textEncoder.encode(body));
  if (!ok) {
    throw new Error("Invalid state signature");
  }

  const payload = JSON.parse(textDecoder.decode(base64ToBytes(body)));
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid state payload");
  }

  const exp = Number((payload as { exp?: unknown }).exp ?? 0);
  if (!Number.isFinite(exp) || exp <= Math.floor(Date.now() / 1000)) {
    throw new Error("State token expired");
  }

  return payload as Record<string, unknown>;
}
