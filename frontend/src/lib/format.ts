// src/lib/format.ts - Small display formatting helpers shared across pages.

/**
 * Shortens a wallet address for display, e.g. `0x1234...abcd`.
 * @param address - full 0x-prefixed address
 * @returns the first 6 and last 4 characters joined by an ellipsis
 */
export function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Converts a wei amount to an ETH string for display.
 * @param wei - amount in wei, as a string, number, or bigint
 * @returns locale-formatted ETH value, rounded to at most 4 decimal places
 */
export function weiToEth(wei: string | number | bigint): string {
  const value = typeof wei === "bigint" ? wei : BigInt(wei);
  const eth = Number(value) / 1e18;
  return eth.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

/**
 * Formats an ISO timestamp for display using the browser's locale.
 * @param iso - ISO 8601 timestamp string
 * @returns locale-formatted date and time string
 */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString();
}