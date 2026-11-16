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

import { isPositiveDecimal } from "@/lib/fx";
import {
  MAX_SLIPPAGE_BPS,
  MAX_SWAP_AMOUNT,
  amountSchema,
  appFeeAmount,
  executeSchema,
  quoteSchema,
} from "@/lib/swap-input";

describe("amountSchema", () => {
  it.each(["1", "0.000001", "12.5", "999999999.999999", "1000000000"])("accepts %s", (v) => {
    expect(amountSchema.safeParse(v).success).toBe(true);
  });

  it.each([
    ["zero", "0"],
    ["zero with decimals", "0.000000"],
    ["negative", "-1"],
    ["seven decimals", "0.0000001"],
    ["a long fraction", "0.1234567890123456789"],
    ["exponent", "1e3"],
    ["hex", "0x10"],
    ["leading whitespace", " 1"],
    ["trailing newline", "1\n"],
    ["empty", ""],
    ["trailing dot", "1."],
    ["leading dot", ".5"],
    ["comma", "1,5"],
    ["Infinity", "Infinity"],
    ["NaN", "NaN"],
    ["above the maximum", String(MAX_SWAP_AMOUNT + 1)],
  ])("rejects %s", (_name, v) => {
    expect(amountSchema.safeParse(v).success).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(amountSchema.safeParse(1).success).toBe(false);
    expect(amountSchema.safeParse(null).success).toBe(false);
  });
});

describe("quoteSchema", () => {
  it("accepts a valid quote request", () => {
    expect(quoteSchema.safeParse({ from: "USDC", to: "EURC", amountIn: "10" }).success).toBe(true);
  });

  it("rejects the same token on both sides", () => {
    const result = quoteSchema.safeParse({ from: "USDC", to: "USDC", amountIn: "10" });
    expect(result.success).toBe(false);
  });

  it("rejects tokens outside the allow-list", () => {
    expect(quoteSchema.safeParse({ from: "USDC", to: "DAI", amountIn: "10" }).success).toBe(false);
    expect(quoteSchema.safeParse({ from: "usdc", to: "EURC", amountIn: "10" }).success).toBe(false);
  });
});

describe("executeSchema", () => {
  const valid = { from: "USDC", to: "EURC", amountIn: "10", slippageBps: 50 } as const;

  it("accepts a valid request, with or without minOut", () => {
    expect(executeSchema.safeParse(valid).success).toBe(true);
    expect(executeSchema.safeParse({ ...valid, minOut: "9.5" }).success).toBe(true);
  });

  it("accepts slippage from 0 up to the cap", () => {
    expect(executeSchema.safeParse({ ...valid, slippageBps: 0 }).success).toBe(true);
    expect(executeSchema.safeParse({ ...valid, slippageBps: MAX_SLIPPAGE_BPS }).success).toBe(true);
  });

  it("rejects slippage above the cap (the old limit was 100%)", () => {
    expect(executeSchema.safeParse({ ...valid, slippageBps: MAX_SLIPPAGE_BPS + 1 }).success).toBe(false);
    expect(executeSchema.safeParse({ ...valid, slippageBps: 10_000 }).success).toBe(false);
  });

  it("rejects negative, fractional and non-numeric slippage", () => {
    for (const slippageBps of [-1, 0.5, Number.NaN, Infinity, "50"]) {
      expect(executeSchema.safeParse({ ...valid, slippageBps }).success).toBe(false);
    }
  });

  it("rejects a minOut that is not a plain amount", () => {
    for (const minOut of ["abc", "1e3", "-1", "0", "1; drop table swaps", "0.0000001"]) {
      expect(executeSchema.safeParse({ ...valid, minOut }).success).toBe(false);
    }
  });
});

describe("appFeeAmount", () => {
  it("computes the fee in exact base units", () => {
    expect(appFeeAmount("100", 25)).toBe("0.250000");
    expect(appFeeAmount("1", 100)).toBe("0.010000");
    expect(appFeeAmount("0.000001", 10_000)).toBe("0.000001");
  });

  it("does not drift the way floating point does", () => {
    // 0.1 + 0.2 territory: 33.33 * 25 / 10000 is not exact in floating point.
    expect(appFeeAmount("33.33", 25)).toBe("0.083325");
    expect(appFeeAmount("1000000000", 25)).toBe("2500000.000000");
  });

  it("rounds down, never up, when the fee is below one base unit", () => {
    expect(appFeeAmount("0.000001", 25)).toBe("0.000000");
  });

  it("is zero for a zero fee", () => {
    expect(appFeeAmount("123.456789", 0)).toBe("0.000000");
  });
});

describe("isPositiveDecimal (client guard)", () => {
  it("agrees with the server: at most 6 decimals", () => {
    expect(isPositiveDecimal("1.123456")).toBe(true);
    expect(isPositiveDecimal("1.1234567")).toBe(false);
    expect(isPositiveDecimal("0")).toBe(false);
    expect(isPositiveDecimal("1e3")).toBe(false);
  });
});
