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

import { describe, expect, it } from "vitest";

import { createRateLimiter } from "@/lib/rate-limit";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe("createRateLimiter", () => {
  it("allows up to the limit, then blocks", () => {
    const c = clock();
    const check = createRateLimiter({ limit: 3, windowMs: 60_000, now: c.now });
    expect(check("a").ok).toBe(true);
    expect(check("a").ok).toBe(true);
    expect(check("a").ok).toBe(true);
    expect(check("a").ok).toBe(false);
  });

  it("tracks keys independently", () => {
    const c = clock();
    const check = createRateLimiter({ limit: 1, windowMs: 60_000, now: c.now });
    expect(check("a").ok).toBe(true);
    expect(check("b").ok).toBe(true);
    expect(check("a").ok).toBe(false);
  });

  it("frees a slot once the window has passed", () => {
    const c = clock();
    const check = createRateLimiter({ limit: 1, windowMs: 60_000, now: c.now });
    expect(check("a").ok).toBe(true);
    c.advance(59_999);
    expect(check("a").ok).toBe(false);
    c.advance(1);
    expect(check("a").ok).toBe(true);
  });

  it("reports how long until the oldest hit expires, rounded up", () => {
    const c = clock();
    const check = createRateLimiter({ limit: 1, windowMs: 60_000, now: c.now });
    check("a");
    c.advance(10_500);
    const result = check("a");
    expect(result).toEqual({ ok: false, retryAfterSeconds: 50 });
  });

  it("does not count blocked attempts against the caller", () => {
    const c = clock();
    const check = createRateLimiter({ limit: 1, windowMs: 60_000, now: c.now });
    check("a");
    for (let i = 0; i < 20; i++) {
      c.advance(1_000);
      expect(check("a").ok).toBe(false);
    }
    c.advance(40_000);
    expect(check("a").ok).toBe(true);
  });

  it("stays bounded under many distinct keys", () => {
    const c = clock();
    const check = createRateLimiter({ limit: 1, windowMs: 60_000, now: c.now });
    for (let i = 0; i < 10_050; i++) check(`k${i}`);
    // Cleared once past 10k keys, so an old key is allowed again rather than remembered forever.
    expect(check("k0").ok).toBe(true);
  });
});
