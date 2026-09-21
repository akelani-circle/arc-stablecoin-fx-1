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

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
  now?: () => number;
}

export type RateLimitResult = { ok: true } | { ok: false; retryAfterSeconds: number };

/**
 * A sliding-window limiter, in memory. Each call it guards spends the app's Circle quota,
 * and server actions are public POST endpoints, so a signed-in user could otherwise loop
 * on them. In memory means per server instance: it bounds one instance's spend, and a
 * multi-instance deployment needs a shared store.
 */
export function createRateLimiter({ limit, windowMs, now = Date.now }: RateLimitOptions) {
  const hits = new Map<string, number[]>();

  return function check(key: string): RateLimitResult {
    const t = now();
    const recent = (hits.get(key) ?? []).filter((time) => t - time < windowMs);

    if (recent.length >= limit) {
      hits.set(key, recent);
      return { ok: false, retryAfterSeconds: Math.ceil((windowMs - (t - recent[0])) / 1000) };
    }

    hits.set(key, [...recent, t]);
    // Do not grow without bound under many distinct keys.
    if (hits.size > 10_000) hits.clear();
    return { ok: true };
  };
}
