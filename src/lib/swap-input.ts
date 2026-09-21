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

import { z } from "zod";

import { FX_TOKENS } from "@/lib/fx";

/** USDC and EURC both have 6 decimals. */
export const TOKEN_DECIMALS = 6;

/** The largest amount one swap may move, in whole tokens. */
export const MAX_SWAP_AMOUNT = 1_000_000_000;

/**
 * The most slippage a swap may allow: 10%. The client offers 0.1%, 0.5% and 1%, but a server
 * action is a public POST endpoint, and the old cap of 100% let a request disable slippage
 * protection completely.
 */
export const MAX_SLIPPAGE_BPS = 1_000;

const DECIMAL = new RegExp(`^\\d+(\\.\\d{1,${TOKEN_DECIMALS}})?$`);

/**
 * A positive decimal with at most 6 places and no exponent, sign or whitespace. The old
 * pattern allowed any number of decimals, so "0.1234567890123456789" reached the database
 * (numeric(38,18) overflows) and the SDK.
 */
export const amountSchema = z
  .string()
  .regex(DECIMAL, `Enter an amount with at most ${TOKEN_DECIMALS} decimal places`)
  .refine((v) => Number(v) > 0, "Must be > 0")
  .refine((v) => Number(v) <= MAX_SWAP_AMOUNT, "Amount is too large");

export const tokenSchema = z.enum(FX_TOKENS);

export const quoteSchema = z
  .object({ from: tokenSchema, to: tokenSchema, amountIn: amountSchema })
  .refine((v) => v.from !== v.to, { message: "From and To must differ" });

export const executeSchema = z
  .object({
    from: tokenSchema,
    to: tokenSchema,
    amountIn: amountSchema,
    slippageBps: z.number().int().min(0).max(MAX_SLIPPAGE_BPS),
    // The lowest output the user will accept. Same shape as an amount, so it cannot smuggle
    // an arbitrary string into the SDK's stop limit.
    minOut: amountSchema.optional(),
  })
  .refine((v) => v.from !== v.to, { message: "From and To must differ" });

/**
 * The app's fee on `amountIn`, computed in integer base units. The old code did
 * (Number(amount) * bps) / 10000 in floating point, which drifts on decimals.
 */
export function appFeeAmount(amountIn: string, feeBps: number): string {
  const [whole, fraction = ""] = amountIn.split(".");
  const micro = BigInt(whole) * BigInt(10 ** TOKEN_DECIMALS) + BigInt(fraction.padEnd(TOKEN_DECIMALS, "0"));
  const fee = (micro * BigInt(feeBps)) / BigInt(10_000);
  const feeWhole = fee / BigInt(10 ** TOKEN_DECIMALS);
  const feeFraction = (fee % BigInt(10 ** TOKEN_DECIMALS)).toString().padStart(TOKEN_DECIMALS, "0");
  return `${feeWhole}.${feeFraction}`;
}
