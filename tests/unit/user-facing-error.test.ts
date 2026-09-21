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

import { toUserFacingError } from "@/lib/user-facing-error";

describe("toUserFacingError", () => {
  it.each([
    ["Insufficient funds for transfer", "Insufficient balance for this swap."],
    ["amount exceeds balance", "Insufficient balance for this swap."],
    ["Slippage exceeded", "The price moved beyond your slippage limit. Try again or raise the limit."],
    ["stop limit not met", "The price moved beyond your slippage limit. Try again or raise the limit."],
    ["intrinsic gas too low", "The network fee could not be paid. Check your balance and try again."],
    ["429 Too Many Requests", "Too many requests. Please wait a moment and try again."],
    ["fetch failed", "Network error. Please try again."],
    ["request timed out", "Network error. Please try again."],
  ])("maps %j to a safe message", (raw, expected) => {
    expect(toUserFacingError(new Error(raw))).toBe(expected);
  });

  it("accepts plain strings", () => {
    expect(toUserFacingError("Insufficient balance")).toBe("Insufficient balance for this swap.");
  });

  it("never leaks the raw message of an unrecognised error", () => {
    const secret = "AxiosError: Request failed with status code 401 {apiKey: TEST_API_KEY:abc:def, entitySecret: deadbeef}";
    const message = toUserFacingError(new Error(secret));
    expect(message).toBe("The swap could not be completed. Please try again.");
    expect(message).not.toContain("TEST_API_KEY");
    expect(message).not.toContain("deadbeef");
  });

  it("does not throw on non-error values", () => {
    for (const value of [undefined, null, 42, {}, [], Symbol("x")]) {
      expect(toUserFacingError(value)).toBe("The swap could not be completed. Please try again.");
    }
  });

  it("uses the caller's fallback for unknown errors", () => {
    expect(toUserFacingError(new Error("boom"), "Could not fetch a quote.")).toBe("Could not fetch a quote.");
  });
});
