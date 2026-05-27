const textEncoder = new TextEncoder();

export async function digestSha256Hex(
  value: string,
  cryptoImpl: Crypto | undefined = globalThis.crypto,
): Promise<string> {
  if (cryptoImpl?.subtle === undefined) {
    throw new Error("Web Crypto API is unavailable in this environment.");
  }

  const hash = await cryptoImpl.subtle.digest("SHA-256", textEncoder.encode(value));
  const bytes = new Uint8Array(hash);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
