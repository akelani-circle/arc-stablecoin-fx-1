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

import "../helpers/env";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { queryBuilder, queueTables } from "../helpers/supabase-mock";

const userClient = { auth: { getUser: vi.fn() }, from: vi.fn() };
const adminClient = { from: vi.fn() };
const estimateSwap = vi.fn();
const executeSwap = vi.fn();
const getFxBalances = vi.fn();
const revalidatePath = vi.fn();

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => userClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => adminClient }));
vi.mock("@/lib/appkit/swap", () => ({ estimateSwap, executeSwap }));
vi.mock("@/lib/circle/wallets", () => ({ getFxBalances }));
vi.mock("next/cache", () => ({ revalidatePath }));

const USER = { id: "11111111-1111-4111-8111-111111111111" };
const PROFILE = { circle_wallet_id: "wallet-1", wallet_address: "0x1111111111111111111111111111111111111111" };
const valid = { from: "USDC", to: "EURC", amountIn: "10", slippageBps: 50 } as const;

function signedIn(profile: typeof PROFILE | null = PROFILE) {
  userClient.auth.getUser.mockResolvedValue({ data: { user: USER } });
  queueTables(userClient, {
    profiles: [queryBuilder({ data: profile, error: profile ? null : { message: "no rows" } })],
  });
}

async function actions() {
  // A fresh module per test: the quote rate limiter is module state.
  vi.resetModules();
  return import("@/app/(app)/dashboard/actions");
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  getFxBalances.mockResolvedValue({ USDC: "90", EURC: "9" });
});

describe("quoteSwap", () => {
  it("rejects bad input before touching auth or Circle", async () => {
    const { quoteSwap } = await actions();
    const result = await quoteSwap({ from: "USDC", to: "EURC", amountIn: "0.1234567" });
    expect(result.ok).toBe(false);
    expect(userClient.auth.getUser).not.toHaveBeenCalled();
    expect(estimateSwap).not.toHaveBeenCalled();
  });

  it("requires a signed-in user", async () => {
    userClient.auth.getUser.mockResolvedValue({ data: { user: null } });
    const { quoteSwap } = await actions();
    expect(await quoteSwap({ from: "USDC", to: "EURC", amountIn: "10" })).toEqual({ ok: false, error: "Not authenticated" });
    expect(estimateSwap).not.toHaveBeenCalled();
  });

  it("quotes with the caller's own wallet and returns an exact fee", async () => {
    signedIn();
    estimateSwap.mockResolvedValue({ amountOut: "9.2", appFeeBps: 25, effectiveRate: "0.92" });
    const { quoteSwap } = await actions();
    const result = await quoteSwap({ from: "USDC", to: "EURC", amountIn: "33.33" });
    expect(result).toEqual({ ok: true, amountOut: "9.2", effectiveRate: "0.92", appFeeBps: 25, appFeeAmount: "0.083325" });
    expect(estimateSwap).toHaveBeenCalledWith({
      walletAddress: PROFILE.wallet_address,
      tokenIn: "USDC",
      tokenOut: "EURC",
      amountIn: "33.33",
    });
  });

  it("does not leak the SDK's raw error", async () => {
    signedIn();
    estimateSwap.mockRejectedValue(new Error("401 Unauthorized apiKey=TEST_API_KEY:aaaa:bbbb"));
    const { quoteSwap } = await actions();
    const result = await quoteSwap({ from: "USDC", to: "EURC", amountIn: "10" });
    expect(result).toEqual({ ok: false, error: "Could not fetch a quote. Please try again." });
  });

  it("rate limits a user after 30 quotes a minute", async () => {
    userClient.auth.getUser.mockResolvedValue({ data: { user: USER } });
    userClient.from.mockImplementation(() => queryBuilder({ data: PROFILE }));
    estimateSwap.mockResolvedValue({ amountOut: "9", appFeeBps: 25, effectiveRate: "0.9" });
    const { quoteSwap } = await actions();
    for (let i = 0; i < 30; i++) {
      expect((await quoteSwap({ from: "USDC", to: "EURC", amountIn: "10" })).ok).toBe(true);
    }
    const blocked = await quoteSwap({ from: "USDC", to: "EURC", amountIn: "10" });
    expect(blocked.ok).toBe(false);
    expect(!blocked.ok && blocked.error).toMatch(/Too many quotes/);
    expect(estimateSwap).toHaveBeenCalledTimes(30);
  });
});

describe("executeSwapAction", () => {
  function queueAdmin(insert: { data?: unknown; error?: { message: string; code?: string } | null }) {
    const stale = queryBuilder();
    const inserted = queryBuilder(insert);
    const finish = queryBuilder();
    const balances = queryBuilder();
    queueTables(adminClient, { swaps: [stale, inserted, finish], wallet_balances: [balances] });
    return { stale, inserted, finish, balances };
  }

  it("rejects a slippage above the cap without calling anything", async () => {
    const { executeSwapAction } = await actions();
    const result = await executeSwapAction({ ...valid, slippageBps: 10_000 });
    expect(result.ok).toBe(false);
    expect(userClient.auth.getUser).not.toHaveBeenCalled();
    expect(executeSwap).not.toHaveBeenCalled();
  });

  it("rejects an amount with too many decimals or an unknown token", async () => {
    const { executeSwapAction } = await actions();
    expect((await executeSwapAction({ ...valid, amountIn: "1.0000001" })).ok).toBe(false);
    expect((await executeSwapAction({ ...valid, to: "DAI" as never })).ok).toBe(false);
    expect(executeSwap).not.toHaveBeenCalled();
  });

  it("requires a signed-in user and never reaches Circle or the database", async () => {
    userClient.auth.getUser.mockResolvedValue({ data: { user: null } });
    const { executeSwapAction } = await actions();
    expect(await executeSwapAction(valid)).toEqual({ ok: false, error: "Not authenticated" });
    expect(adminClient.from).not.toHaveBeenCalled();
    expect(executeSwap).not.toHaveBeenCalled();
  });

  it("fails when the user has no profile", async () => {
    signedIn(null);
    const { executeSwapAction } = await actions();
    expect(await executeSwapAction(valid)).toEqual({ ok: false, error: "Profile not found" });
    expect(executeSwap).not.toHaveBeenCalled();
  });

  it("records the swap as pending before calling Circle, then confirms it", async () => {
    signedIn();
    const q = queueAdmin({ data: { id: "swap-1" } });
    executeSwap.mockImplementation(async () => {
      // At this point the pending row must already exist.
      expect(q.inserted.insert).toHaveBeenCalled();
      return { amountOut: "9.1", txHash: "0xabc" };
    });
    const { executeSwapAction } = await actions();

    const result = await executeSwapAction({ ...valid, minOut: "9" });

    expect(result).toEqual({ ok: true, swapId: "swap-1" });
    expect(q.inserted.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: USER.id,
        from_token: "USDC",
        to_token: "EURC",
        amount_in: "10",
        min_out: "9",
        slippage_bps: 50,
        status: "pending",
      }),
    );
    expect(executeSwap).toHaveBeenCalledWith({
      walletAddress: PROFILE.wallet_address,
      tokenIn: "USDC",
      tokenOut: "EURC",
      amountIn: "10",
      slippageBps: 50,
      stopLimit: "9",
    });
    expect(q.finish.update).toHaveBeenCalledWith({ status: "confirmed", quoted_out: "9.1", tx_hash: "0xabc" });
    expect(q.finish.eq).toHaveBeenCalledWith("id", "swap-1");
    expect(q.balances.upsert).toHaveBeenCalledWith({ user_id: USER.id, usdc: "90", eurc: "9" });
    expect(revalidatePath).toHaveBeenCalledWith("/dashboard");
  });

  it("uses the wallet from the caller's profile, never one from the request", async () => {
    signedIn();
    queueAdmin({ data: { id: "swap-1" } });
    executeSwap.mockResolvedValue({});
    const { executeSwapAction } = await actions();
    await executeSwapAction({ ...valid, walletAddress: "0x2222222222222222222222222222222222222222" } as never);
    expect(executeSwap.mock.calls[0][0].walletAddress).toBe(PROFILE.wallet_address);
  });

  it("expires this user's stale in-flight swaps before inserting", async () => {
    signedIn();
    const q = queueAdmin({ data: { id: "swap-1" } });
    executeSwap.mockResolvedValue({});
    const { executeSwapAction } = await actions();
    await executeSwapAction(valid);
    expect(q.stale.update).toHaveBeenCalledWith({ status: "failed", error: "Timed out" });
    expect(q.stale.eq).toHaveBeenCalledWith("user_id", USER.id);
    expect(q.stale.in).toHaveBeenCalledWith("status", ["pending", "submitted"]);
    expect(q.stale.lt).toHaveBeenCalledWith("created_at", expect.any(String));
    const cutoff = Date.parse(q.stale.lt.mock.calls[0][1]);
    expect(Date.now() - cutoff).toBeGreaterThan(9 * 60_000);
    expect(Date.now() - cutoff).toBeLessThan(11 * 60_000);
  });

  it("refuses a second swap while one is in flight, without calling Circle", async () => {
    signedIn();
    queueAdmin({ data: null, error: { message: 'duplicate key value violates unique constraint "swaps_one_inflight_per_user"', code: "23505" } });
    const { executeSwapAction } = await actions();
    expect(await executeSwapAction(valid)).toEqual({ ok: false, error: "A swap is already in progress. Wait for it to finish." });
    expect(executeSwap).not.toHaveBeenCalled();
  });

  it("hides other database errors and does not call Circle", async () => {
    signedIn();
    queueAdmin({ data: null, error: { message: 'relation "swaps" is locked by 10.0.3.4', code: "55P03" } });
    const { executeSwapAction } = await actions();
    const result = await executeSwapAction(valid);
    expect(result).toEqual({ ok: false, error: "Could not start the swap. Please try again." });
    expect(executeSwap).not.toHaveBeenCalled();
  });

  it("stores and returns a safe message when the swap fails", async () => {
    signedIn();
    const q = queueAdmin({ data: { id: "swap-1" } });
    executeSwap.mockRejectedValue(new Error("Request failed: POST https://api.circle.com/v1/w3s/... apiKey=TEST_API_KEY:aaaa:bbbb"));
    const { executeSwapAction } = await actions();

    const result = await executeSwapAction(valid);

    expect(result).toEqual({ ok: false, error: "The swap could not be completed. Please try again." });
    expect(q.finish.update).toHaveBeenCalledWith({ status: "failed", error: "The swap could not be completed. Please try again." });
    expect(JSON.stringify(q.finish.update.mock.calls)).not.toContain("TEST_API_KEY");
    expect(q.balances.upsert).not.toHaveBeenCalled();
  });

  it("maps a known failure to a clear message", async () => {
    signedIn();
    queueAdmin({ data: { id: "swap-1" } });
    executeSwap.mockRejectedValue(new Error("Insufficient funds"));
    const { executeSwapAction } = await actions();
    expect(await executeSwapAction(valid)).toEqual({ ok: false, error: "Insufficient balance for this swap." });
  });

  it("still succeeds when the balance refresh fails afterwards", async () => {
    signedIn();
    queueAdmin({ data: { id: "swap-1" } });
    executeSwap.mockResolvedValue({ amountOut: "9", txHash: "0x1" });
    getFxBalances.mockRejectedValue(new Error("circle down"));
    const { executeSwapAction } = await actions();
    expect(await executeSwapAction(valid)).toEqual({ ok: true, swapId: "swap-1" });
  });

  it("writes only through the admin client, never the user's", async () => {
    signedIn();
    queueAdmin({ data: { id: "swap-1" } });
    executeSwap.mockResolvedValue({});
    const { executeSwapAction } = await actions();
    await executeSwapAction(valid);
    // The user's client is used for the profile read and nothing else.
    expect(userClient.from.mock.calls.map((c) => c[0])).toEqual(["profiles"]);
  });
});
