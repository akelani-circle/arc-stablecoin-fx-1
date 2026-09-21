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

"use server";

import { revalidatePath } from "next/cache";

import { estimateSwap, executeSwap } from "@/lib/appkit/swap";
import { getFxBalances } from "@/lib/circle/wallets";
import { serverEnv } from "@/lib/config";
import { type FxToken } from "@/lib/fx";
import { createRateLimiter } from "@/lib/rate-limit";
import { appFeeAmount, executeSchema, quoteSchema } from "@/lib/swap-input";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { toUserFacingError } from "@/lib/user-facing-error";

export type QuoteState =
  | { ok: true; amountOut: string; effectiveRate: string; appFeeBps: number; appFeeAmount: string }
  | { ok: false; error: string };

// Quotes call Circle on the app's account, and the swap panel asks for one as the user types.
const quoteLimiter = createRateLimiter({ limit: 30, windowMs: 60_000 });

// A swap that has been "pending" this long has almost certainly died mid-flight (a crash or a
// timeout before the row was updated). Expire it so it cannot block the user forever.
const STALE_SWAP_MS = 10 * 60 * 1000;

async function getProfile() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not authenticated");
  const { data: profile, error } = await supabase
    .from("profiles")
    .select("circle_wallet_id, wallet_address")
    .eq("id", user.id)
    .single();
  if (error || !profile) throw new Error("Profile not found");
  return { user, profile };
}

export async function quoteSwap(input: {
  from: FxToken;
  to: FxToken;
  amountIn: string;
}): Promise<QuoteState> {
  const parsed = quoteSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid quote input" };
  }

  let user;
  let profile;
  try {
    ({ user, profile } = await getProfile());
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Not authenticated" };
  }

  const limited = quoteLimiter(user.id);
  if (!limited.ok) {
    return { ok: false, error: `Too many quotes. Try again in ${limited.retryAfterSeconds}s.` };
  }

  try {
    const env = serverEnv();
    const result = await estimateSwap({
      walletAddress: profile.wallet_address,
      tokenIn: parsed.data.from,
      tokenOut: parsed.data.to,
      amountIn: parsed.data.amountIn,
    });
    return {
      ok: true,
      amountOut: result.amountOut,
      effectiveRate: result.effectiveRate,
      appFeeBps: env.APP_FEE_BPS,
      appFeeAmount: appFeeAmount(parsed.data.amountIn, env.APP_FEE_BPS),
    };
  } catch (err) {
    console.error("[quoteSwap] failed:", err instanceof Error ? err.message : err);
    return { ok: false, error: toUserFacingError(err, "Could not fetch a quote. Please try again.") };
  }
}

export type ExecuteState =
  | { ok: true; swapId: string }
  | { ok: false; error: string };

export async function executeSwapAction(input: {
  from: FxToken;
  to: FxToken;
  amountIn: string;
  slippageBps: number;
  minOut?: string;
}): Promise<ExecuteState> {
  const parsed = executeSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  let user;
  let profile;
  try {
    ({ user, profile } = await getProfile());
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Auth error" };
  }

  const env = serverEnv();
  const admin = createAdminClient();

  await admin
    .from("swaps")
    .update({ status: "failed", error: "Timed out" })
    .eq("user_id", user.id)
    .in("status", ["pending", "submitted"])
    .lt("created_at", new Date(Date.now() - STALE_SWAP_MS).toISOString());

  // One in-flight swap per user, enforced by a unique index on (user_id) where the status is
  // pending or submitted. Two quick clicks (or two tabs) used to run two swaps.
  const { data: pending, error: insertError } = await admin
    .from("swaps")
    .insert({
      user_id: user.id,
      from_token: parsed.data.from,
      to_token: parsed.data.to,
      amount_in: parsed.data.amountIn,
      min_out: parsed.data.minOut ?? null,
      slippage_bps: parsed.data.slippageBps,
      app_fee_bps: env.APP_FEE_BPS,
      status: "pending",
    })
    .select("id")
    .single();

  if (insertError || !pending) {
    if (insertError?.code === "23505") {
      return { ok: false, error: "A swap is already in progress. Wait for it to finish." };
    }
    console.error("[executeSwapAction] could not create the swap record:", insertError?.message);
    return { ok: false, error: "Could not start the swap. Please try again." };
  }

  try {
    const result = await executeSwap({
      walletAddress: profile.wallet_address,
      tokenIn: parsed.data.from,
      tokenOut: parsed.data.to,
      amountIn: parsed.data.amountIn,
      slippageBps: parsed.data.slippageBps,
      stopLimit: parsed.data.minOut,
    });

    const { error: updateError } = await admin
      .from("swaps")
      .update({
        status: "confirmed",
        quoted_out: result.amountOut ?? null,
        tx_hash: result.txHash ?? null,
      })
      .eq("id", pending.id);
    if (updateError) {
      console.error(`[executeSwapAction] swap ${pending.id} succeeded but could not be marked confirmed:`, updateError.message);
    }

    try {
      const balances = await getFxBalances(profile.circle_wallet_id);
      await admin
        .from("wallet_balances")
        .upsert({ user_id: user.id, usdc: balances.USDC, eurc: balances.EURC });
    } catch (balanceErr) {
      console.warn("[executeSwapAction] balance refresh failed (non-fatal):", balanceErr instanceof Error ? balanceErr.message : balanceErr);
    }

    revalidatePath("/dashboard");
    return { ok: true, swapId: pending.id };
  } catch (err) {
    console.error(`[executeSwapAction] swap ${pending.id} failed:`, err instanceof Error ? err.message : err);

    // The row is readable by the user, so it gets the safe message, not the raw error.
    const message = toUserFacingError(err);
    const { error: failError } = await admin
      .from("swaps")
      .update({ status: "failed", error: message })
      .eq("id", pending.id);
    if (failError) {
      console.error(`[executeSwapAction] swap ${pending.id} could not be marked failed:`, failError.message);
    }
    return { ok: false, error: message };
  }
}
