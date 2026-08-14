// Must mirror buildNotificationAuthMessage in backend/src/server.ts
// byte-for-byte, or every signature fails verification - same convention as
// the CID/hash mirroring in hash.ts.

/** `wallet` must already be lowercased by the caller. */
export function buildNotificationAuthMessage(wallet: string, issuedAt: number): string {
  return `DeReddit notifications access for ${wallet} at ${issuedAt}`;
}
