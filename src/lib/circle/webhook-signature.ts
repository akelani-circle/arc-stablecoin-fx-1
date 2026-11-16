/**
 * Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import "server-only";

import { createPublicKey, createVerify, timingSafeEqual, createHash } from "node:crypto";

const KEY_TTL_MS = 60 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 1000;
const MAX_CACHED_KEYS = 50;
const KEY_ID = /^[0-9a-zA-Z-]{8,64}$/;

const keyCache = new Map<string, { pem: string; expires: number }>();
// Remembered failures, so a stream of made-up key ids cannot make us call Circle each time.
const failureCache = new Map<string, number>();

/**
 * Circle's public key for a webhook `keyId`, as PEM. Cached: it is fetched with the app's API
 * key and the same key signs every notification, so there is no reason to call Circle on
 * each delivery (and a flood of bogus ones would otherwise burn API quota).
 */
async function getCirclePublicKey(keyId: string, apiKey: string, fetchImpl: typeof fetch): Promise<string> {
  const cached = keyCache.get(keyId);
  if (cached && cached.expires > Date.now()) return cached.pem;

  const failedUntil = failureCache.get(keyId);
  if (failedUntil && failedUntil > Date.now()) throw new Error("Public key lookup failed recently");

  try {
    const response = await fetchImpl(`https://api.circle.com/v2/notifications/publicKey/${encodeURIComponent(keyId)}`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) throw new Error(`Could not fetch the Circle public key (${response.status})`);

    const raw = (await response.json())?.data?.publicKey;
    if (typeof raw !== "string" || raw.length === 0) throw new Error("Circle returned no public key");

    const pem = ["-----BEGIN PUBLIC KEY-----", ...(raw.match(/.{1,64}/g) ?? []), "-----END PUBLIC KEY-----"].join("\n");
    createPublicKey(pem); // throws if it is not a valid key: never cache garbage

    if (keyCache.size >= MAX_CACHED_KEYS) keyCache.clear();
    keyCache.set(keyId, { pem, expires: Date.now() + KEY_TTL_MS });
    return pem;
  } catch (error) {
    if (failureCache.size >= MAX_CACHED_KEYS) failureCache.clear();
    failureCache.set(keyId, Date.now() + FAILURE_TTL_MS);
    throw error;
  }
}

/**
 * Verifies that `rawBody` was signed by Circle. Fails closed: any error, a missing header or
 * an unset API key means "not verified". Verify the raw bytes, not a re-serialization.
 */
export async function verifyCircleSignature(
  rawBody: string,
  signature: string | null,
  keyId: string | null,
  apiKey: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (!signature || !keyId || !apiKey || !KEY_ID.test(keyId)) return false;

  try {
    const publicKey = await getCirclePublicKey(keyId, apiKey, fetchImpl);
    const verifier = createVerify("SHA256");
    verifier.update(rawBody);
    verifier.end();
    return verifier.verify(publicKey, Buffer.from(signature, "base64"));
  } catch (error) {
    console.error("[webhook/circle] signature verification failed:", error instanceof Error ? error.message : error);
    return false;
  }
}

/** Constant-time string comparison, for the optional extra bearer secret. */
export function safeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** Test hook: forget cached keys and failures. */
export function clearKeyCache() {
  keyCache.clear();
  failureCache.clear();
}
