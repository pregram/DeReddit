// Swappable later: just change VITE_IPFS_API_URL / VITE_IPFS_GATEWAY_URL in
// .env - no code changes needed here.

import { env } from "./env";

async function uploadBlobToIPFS(blob: Blob): Promise<string> {
  const form = new FormData();
  form.append("file", blob);

  let response: Response;
  try {
    response = await fetch(`${env.ipfsApiUrl}/api/v0/add?cid-version=0&pin=true`, {
      method: "POST",
      body: form,
    });
  } catch {
    throw new Error(
      "Could not reach the IPFS node. Is `ipfs daemon` running, and is CORS enabled for this origin?"
    );
  }

  if (!response.ok) {
    throw new Error(`IPFS upload failed with status ${response.status}.`);
  }

  const result = (await response.json()) as { Hash: string };
  return result.Hash;
}

/**
 * Uploads a JSON object to IPFS and returns its CIDv0 string (e.g. "Qm...").
 * Requires a local kubo daemon (`ipfs daemon`) with CORS enabled for this origin.
 */
export async function uploadJsonToIPFS(data: unknown): Promise<string> {
  return uploadBlobToIPFS(new Blob([JSON.stringify(data)], { type: "application/json" }));
}

/**
 * Uploads a raw file (image, etc.) to IPFS and returns its CIDv0 string.
 * Same kubo endpoint as uploadJsonToIPFS, just without the JSON-stringify step.
 */
export async function uploadFileToIPFS(file: File): Promise<string> {
  return uploadBlobToIPFS(file);
}

/** Builds the browser-facing gateway URL for a CID, using `VITE_IPFS_GATEWAY_URL`. */
export function ipfsGatewayUrl(cid: string): string {
  return `${env.ipfsGatewayUrl}${cid}`;
}

// A CID already pinned on this gateway resolves in well under a second -
// anything past a few seconds means the gateway had to fall back to a DHT/
// bitswap search across the public network (e.g. content pinned by a
// different node/session), which can otherwise hang for minutes with no
// feedback. Bounding it here means a slow/unreachable CID fails fast with a
// readable error instead of leaving the caller's UI stuck on a spinner.
const IPFS_FETCH_TIMEOUT_MS = 8000;

/**
 * Fetches and parses JSON content already stored on IPFS. Used by the
 * "finish poll setup" flow to re-read a post's pollChoices (which live
 * inside the same JSON payload uploaded during step 1 - no separate
 * storage needed for the deferred step 2).
 */
export async function fetchJsonFromIPFS<T>(cid: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), IPFS_FETCH_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(ipfsGatewayUrl(cid), { signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(
        `Timed out fetching IPFS content for ${cid} - the gateway likely doesn't have this content locally and couldn't find a peer serving it in time.`
      );
    }
    throw new Error("Could not reach the IPFS gateway. Check your connection and try again.");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch IPFS content for ${cid} (status ${response.status}).`);
  }
  return response.json() as Promise<T>;
}