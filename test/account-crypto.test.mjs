import test from "node:test";
import assert from "node:assert/strict";
import {
  createAccountKeyEnvelope,
  decryptAccountPassword,
  encryptAccountPassword,
  unlockAccountKeyEnvelope,
} from "../scripts/account-crypto.mjs";

test("world key envelope survives serialization and encrypts passwords for the connector", async () => {
  const passphrase = "a-long-test-connector-phrase";
  const envelope = await createAccountKeyEnvelope({
    passphrase,
    worldId: "test-world",
    connectorUserId: "connector-user",
  });
  const saved = JSON.parse(JSON.stringify(envelope));

  assert.equal(saved.worldId, "test-world");
  assert.equal(saved.connectorUserId, "connector-user");
  assert.equal(saved.privateKey.d, undefined);
  assert.equal(saved.privateKey.p, undefined);

  const privateKey = await unlockAccountKeyEnvelope(saved, passphrase, {
    worldId: "test-world",
    connectorUserId: "connector-user",
  });
  const encryptedPassword = await encryptAccountPassword(saved.publicKey, "test-world-password");

  assert.doesNotMatch(JSON.stringify(encryptedPassword), /test-world-password/);
  assert.equal(await decryptAccountPassword(privateKey, encryptedPassword), "test-world-password");
});

test("world key envelope requires its connector passphrase and matching world", async () => {
  const envelope = await createAccountKeyEnvelope({
    passphrase: "another-long-connector-phrase",
    worldId: "test-world",
    connectorUserId: "connector-user",
  });

  await assert.rejects(
    unlockAccountKeyEnvelope(envelope, "incorrect-connector-phrase", {
      worldId: "test-world",
      connectorUserId: "connector-user",
    }),
    /connector passphrase is incorrect/,
  );
  await assert.rejects(
    unlockAccountKeyEnvelope(envelope, "another-long-connector-phrase", {
      worldId: "different-world",
      connectorUserId: "connector-user",
    }),
    /does not belong to this world/,
  );
  await assert.rejects(
    unlockAccountKeyEnvelope(
      { ...envelope, worldId: "different-world" },
      "another-long-connector-phrase",
      { worldId: "different-world", connectorUserId: "connector-user" },
    ),
    /passphrase is incorrect|key data is damaged/,
  );
});
