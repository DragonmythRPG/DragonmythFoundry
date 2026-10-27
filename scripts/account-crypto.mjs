const ENVELOPE_VERSION = 1;
const PASSPHRASE_ITERATIONS = 600_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function cryptoApi() {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto is unavailable in this Foundry client.");
  }
  return globalThis.crypto;
}

function encodeBase64(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64(value) {
  if (typeof value !== "string" || !value) {
    throw new Error("The encrypted account data is incomplete.");
  }
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function accountKeyAdditionalData(worldId, connectorUserId) {
  return encoder.encode(JSON.stringify({ version: ENVELOPE_VERSION, worldId, connectorUserId }));
}

async function derivePassphraseKey(passphrase, salt, iterations) {
  const crypto = cryptoApi();
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function createAccountKeyEnvelope({ passphrase, worldId, connectorUserId }) {
  if (typeof passphrase !== "string" || passphrase.length < 16) {
    throw new Error("Use a connector passphrase of at least 16 characters.");
  }
  if (typeof worldId !== "string" || !worldId || typeof connectorUserId !== "string" || !connectorUserId) {
    throw new Error("A Foundry world and connector user are required for account encryption.");
  }

  const crypto = cryptoApi();
  const keyPair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 3072,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );
  const publicKey = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey("jwk", keyPair.privateKey);
  const privateKeyBytes = encoder.encode(JSON.stringify(privateKeyJwk));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));

  try {
    const wrappingKey = await derivePassphraseKey(passphrase, salt, PASSPHRASE_ITERATIONS);
    const encryptedPrivateKey = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: accountKeyAdditionalData(worldId, connectorUserId),
      },
      wrappingKey,
      privateKeyBytes,
    );
    return {
      version: ENVELOPE_VERSION,
      worldId,
      connectorUserId,
      publicKey,
      privateKey: {
        kdf: "PBKDF2-SHA256",
        iterations: PASSPHRASE_ITERATIONS,
        salt: encodeBase64(salt),
        iv: encodeBase64(iv),
        ciphertext: encodeBase64(new Uint8Array(encryptedPrivateKey)),
      },
    };
  } finally {
    privateKeyBytes.fill(0);
    for (const field of ["d", "p", "q", "dp", "dq", "qi", "oth"]) {
      delete privateKeyJwk[field];
    }
  }
}

export async function unlockAccountKeyEnvelope(envelope, passphrase, { worldId, connectorUserId }) {
  if (typeof passphrase !== "string" || passphrase.length < 16) {
    throw new Error("Enter the connector passphrase of at least 16 characters.");
  }
  if (
    !envelope ||
    envelope.version !== ENVELOPE_VERSION ||
    envelope.worldId !== worldId ||
    envelope.connectorUserId !== connectorUserId
  ) {
    throw new Error("The account encryption key does not belong to this world and connector user.");
  }
  const encrypted = envelope.privateKey;
  if (
    encrypted?.kdf !== "PBKDF2-SHA256" ||
    !Number.isSafeInteger(encrypted.iterations) ||
    encrypted.iterations < PASSPHRASE_ITERATIONS ||
    encrypted.iterations > 2_000_000
  ) {
    throw new Error("The saved account encryption key format is unsupported.");
  }

  const crypto = cryptoApi();
  const salt = decodeBase64(encrypted.salt);
  const iv = decodeBase64(encrypted.iv);
  const ciphertext = decodeBase64(encrypted.ciphertext);
  const wrappingKey = await derivePassphraseKey(passphrase, salt, encrypted.iterations);
  const additionalData = accountKeyAdditionalData(worldId, connectorUserId);
  let privateKeyBytes;
  try {
    privateKeyBytes = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData },
      wrappingKey,
      ciphertext,
    ));
  } catch (error) {
    if (error?.name === "OperationError") {
      throw new Error("The connector passphrase is incorrect or the saved key data is damaged.");
    }
    throw error;
  }

  let privateKeyJwk;
  try {
    privateKeyJwk = JSON.parse(decoder.decode(privateKeyBytes));
    return await crypto.subtle.importKey(
      "jwk",
      privateKeyJwk,
      { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      ["decrypt"],
    );
  } finally {
    privateKeyBytes.fill(0);
    if (privateKeyJwk) {
      for (const field of ["d", "p", "q", "dp", "dq", "qi", "oth"]) {
        delete privateKeyJwk[field];
      }
    }
  }
}

export async function encryptAccountPassword(publicKeyJwk, password) {
  if (typeof password !== "string" || !password) {
    throw new Error("A non-empty Foundry password is required.");
  }
  const crypto = cryptoApi();
  const plaintext = encoder.encode(password);
  if (plaintext.length > 4096) {
    plaintext.fill(0);
    throw new Error("The Foundry password is too long to encrypt.");
  }

  const publicKey = await crypto.subtle.importKey(
    "jwk",
    publicKeyJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const aesKeyBytes = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const aesKey = await crypto.subtle.importKey(
      "raw",
      aesKeyBytes,
      { name: "AES-GCM" },
      false,
      ["encrypt"],
    );
    const [ciphertext, wrappedKey] = await Promise.all([
      crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, plaintext),
      crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, aesKeyBytes),
    ]);
    return {
      version: ENVELOPE_VERSION,
      algorithm: "RSA-OAEP-SHA256+A256GCM",
      iv: encodeBase64(iv),
      wrappedKey: encodeBase64(new Uint8Array(wrappedKey)),
      ciphertext: encodeBase64(new Uint8Array(ciphertext)),
    };
  } finally {
    plaintext.fill(0);
    aesKeyBytes.fill(0);
  }
}

export async function decryptAccountPassword(privateKey, envelope) {
  if (
    !privateKey ||
    envelope?.version !== ENVELOPE_VERSION ||
    envelope.algorithm !== "RSA-OAEP-SHA256+A256GCM"
  ) {
    throw new Error("The encrypted Foundry password format is unsupported.");
  }

  const crypto = cryptoApi();
  const iv = decodeBase64(envelope.iv);
  const ciphertext = decodeBase64(envelope.ciphertext);
  const wrappedKey = decodeBase64(envelope.wrappedKey);
  const aesKeyBytes = new Uint8Array(
    await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, wrappedKey),
  );
  let plaintext;
  try {
    const aesKey = await crypto.subtle.importKey(
      "raw",
      aesKeyBytes,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv }, aesKey, ciphertext),
    );
    return decoder.decode(plaintext);
  } finally {
    aesKeyBytes.fill(0);
    plaintext?.fill(0);
  }
}
