import manifest from "../../manifest.json";

const EXPECTED_EXTENSION_ID = "nionemkjcnknfdhdolfloigkhpjnifmf";

async function extensionIdForKey(key: string): Promise<string> {
  const bytes = Uint8Array.from(atob(key), (character) => character.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)).slice(0, 16);
  return Array.from(
    digest,
    (byte) => `${String.fromCharCode(97 + (byte >> 4))}${String.fromCharCode(97 + (byte & 15))}`,
  ).join("");
}

describe("extension manifest identity", () => {
  it("derives the stable native-host extension ID from the checked-in public key", async () => {
    expect(typeof manifest.key).toBe("string");
    expect(await extensionIdForKey(manifest.key)).toBe(EXPECTED_EXTENSION_ID);
  });
});
