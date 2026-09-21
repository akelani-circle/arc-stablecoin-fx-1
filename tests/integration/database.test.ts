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

import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs against the LOCAL Supabase stack: `npm run db:start`, then `npm run test:integration`.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const secretKey = process.env.SUPABASE_SECRET_KEY!;

const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(url, secretKey, options);
const anon = createClient(url, publishableKey, options);

interface TestUser {
  id: string;
  client: SupabaseClient;
}

const createdUsers: string[] = [];
const password = "integration-test-password";

function hex40() {
  return "0x" + randomUUID().replaceAll("-", "").padEnd(40, "a").slice(0, 40);
}

async function makeUser(): Promise<TestUser> {
  const email = `it-${randomUUID()}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  createdUsers.push(data.user.id);

  const client = createClient(url, publishableKey, options);
  const { error: signInError } = await client.auth.signInWithPassword({ email, password });
  if (signInError) throw new Error(`signIn: ${signInError.message}`);

  // What signUp does on the server: a profile and a balance row, written with the secret key.
  const { error: profileError } = await admin
    .from("profiles")
    .insert({ id: data.user.id, circle_wallet_id: `w-${data.user.id}`, wallet_address: hex40() });
  if (profileError) throw new Error(`profile: ${profileError.message}`);
  const { error: balanceError } = await admin.from("wallet_balances").insert({ user_id: data.user.id, usdc: 10, eurc: 5 });
  if (balanceError) throw new Error(`balance: ${balanceError.message}`);
  return { id: data.user.id, client };
}

function swapRow(userId: string, overrides: Record<string, unknown> = {}) {
  return {
    user_id: userId,
    from_token: "USDC",
    to_token: "EURC",
    amount_in: "10",
    slippage_bps: 50,
    app_fee_bps: 25,
    status: "pending",
    ...overrides,
  };
}

let alice: TestUser;
let bob: TestUser;

beforeAll(async () => {
  alice = await makeUser();
  bob = await makeUser();
});

afterAll(async () => {
  // Deleting the auth user cascades to profiles, swaps and wallet_balances.
  for (const id of createdUsers) await admin.auth.admin.deleteUser(id);
});

describe("row level security", () => {
  it("lets a user read only their own profile, balances and swaps", async () => {
    const { data: swap } = await admin.from("swaps").insert(swapRow(alice.id, { status: "confirmed" })).select("id").single();
    expect(swap).not.toBeNull();

    const profiles = await alice.client.from("profiles").select("id");
    expect(profiles.data?.map((r) => r.id)).toEqual([alice.id]);

    const balances = await alice.client.from("wallet_balances").select("user_id, usdc");
    expect(balances.data).toEqual([{ user_id: alice.id, usdc: 10 }]);

    const own = await alice.client.from("swaps").select("id");
    expect(own.data?.map((r) => r.id)).toContain(swap!.id);

    const others = await bob.client.from("swaps").select("id").eq("user_id", alice.id);
    expect(others.data).toEqual([]);
  });

  it("shows nothing to anonymous callers", async () => {
    for (const table of ["profiles", "swaps", "wallet_balances"]) {
      const { data, error } = await anon.from(table).select("*");
      // Either denied outright or an empty result: never rows.
      expect(data ?? []).toEqual([]);
      if (error) expect(error.message).toMatch(/permission denied|not found/i);
    }
  });

  it("does not let a user create swaps, even for themselves", async () => {
    const { error } = await alice.client.from("swaps").insert(swapRow(alice.id, { status: "confirmed" }));
    expect(error).not.toBeNull();
    const { data } = await admin.from("swaps").select("id").eq("user_id", alice.id).eq("amount_in", 10).eq("slippage_bps", 50);
    // Only the row the previous test created through the admin client.
    expect(data).toHaveLength(1);
  });

  it("does not let a user change or delete their own swap history", async () => {
    const { data: swap } = await admin.from("swaps").insert(swapRow(alice.id, { status: "failed", error: "x", amount_in: "3" })).select("id").single();

    await alice.client.from("swaps").update({ status: "confirmed", error: null }).eq("id", swap!.id);
    await alice.client.from("swaps").delete().eq("id", swap!.id);

    const { data } = await admin.from("swaps").select("status, error").eq("id", swap!.id).single();
    expect(data).toEqual({ status: "failed", error: "x" });
  });

  it("does not let a user set their own balance", async () => {
    await alice.client.from("wallet_balances").update({ usdc: 999999 }).eq("user_id", alice.id);
    await alice.client.from("wallet_balances").upsert({ user_id: alice.id, usdc: 999999, eurc: 0 });
    const { data } = await admin.from("wallet_balances").select("usdc").eq("user_id", alice.id).single();
    expect(data?.usdc).toBe(10);
  });

  it("does not let a user repoint their wallet or touch another profile", async () => {
    await alice.client.from("profiles").update({ circle_wallet_id: "attacker-wallet" }).eq("id", alice.id);
    await alice.client.from("profiles").update({ circle_wallet_id: "attacker-wallet" }).eq("id", bob.id);
    const { data } = await admin.from("profiles").select("id, circle_wallet_id").in("id", [alice.id, bob.id]);
    expect(data?.every((p) => p.circle_wallet_id.startsWith("w-"))).toBe(true);
  });
});

describe("swap guards (migration 20260919120000_swap_guards)", () => {
  it("allows only one in-flight swap per user", async () => {
    const carol = await makeUser();
    const first = await admin.from("swaps").insert(swapRow(carol.id)).select("id").single();
    expect(first.error).toBeNull();

    const second = await admin.from("swaps").insert(swapRow(carol.id, { status: "pending" }));
    expect(second.error?.code).toBe("23505");

    const submitted = await admin.from("swaps").insert(swapRow(carol.id, { status: "submitted" }));
    expect(submitted.error?.code).toBe("23505");
  });

  it("frees the slot once the swap finishes, whichever way", async () => {
    const dave = await makeUser();
    const first = await admin.from("swaps").insert(swapRow(dave.id)).select("id").single();
    await admin.from("swaps").update({ status: "confirmed" }).eq("id", first.data!.id);

    const second = await admin.from("swaps").insert(swapRow(dave.id)).select("id").single();
    expect(second.error).toBeNull();
    await admin.from("swaps").update({ status: "failed", error: "x" }).eq("id", second.data!.id);

    const third = await admin.from("swaps").insert(swapRow(dave.id));
    expect(third.error).toBeNull();
  });

  it("does not let one user's swap block another's", async () => {
    const erin = await makeUser();
    const frank = await makeUser();
    expect((await admin.from("swaps").insert(swapRow(erin.id))).error).toBeNull();
    expect((await admin.from("swaps").insert(swapRow(frank.id))).error).toBeNull();
  });

  it("lets the stale-swap expiry query free a stuck user", async () => {
    const gina = await makeUser();
    const old = new Date(Date.now() - 20 * 60_000).toISOString();
    await admin.from("swaps").insert(swapRow(gina.id, { created_at: old }));

    await admin
      .from("swaps")
      .update({ status: "failed", error: "Timed out" })
      .eq("user_id", gina.id)
      .in("status", ["pending", "submitted"])
      .lt("created_at", new Date(Date.now() - 10 * 60_000).toISOString());

    expect((await admin.from("swaps").insert(swapRow(gina.id))).error).toBeNull();
  });

  it("rejects an amount above the maximum, and accepts the maximum", async () => {
    const hal = await makeUser();
    const tooBig = await admin.from("swaps").insert(swapRow(hal.id, { amount_in: "1000000000.000001", status: "failed" }));
    expect(tooBig.error?.message).toMatch(/swaps_amount_in_max/);
    const max = await admin.from("swaps").insert(swapRow(hal.id, { amount_in: "1000000000", status: "failed" }));
    expect(max.error).toBeNull();
  });

  it("requires a lower-case 0x address on new profiles", async () => {
    const ivy = await admin.auth.admin.createUser({ email: `it-${randomUUID()}@example.com`, password, email_confirm: true });
    createdUsers.push(ivy.data.user!.id);
    const id = ivy.data.user!.id;

    for (const bad of ["0xABCDEF0123456789ABCDEF0123456789ABCDEF01", "abcdef0123456789abcdef0123456789abcdef01", "0x1234", "0x" + "g".repeat(40)]) {
      const { error } = await admin.from("profiles").insert({ id, circle_wallet_id: "w", wallet_address: bad });
      expect(error?.message, bad).toMatch(/profiles_wallet_address_format/);
    }
    const ok = await admin.from("profiles").insert({ id, circle_wallet_id: "w", wallet_address: hex40() });
    expect(ok.error).toBeNull();
  });

  it("keeps wallet addresses unique regardless of case", async () => {
    const jack = await makeUser();
    const { data } = await admin.from("profiles").select("wallet_address").eq("id", jack.id).single();
    const kim = await admin.auth.admin.createUser({ email: `it-${randomUUID()}@example.com`, password, email_confirm: true });
    createdUsers.push(kim.data.user!.id);
    const dup = await admin
      .from("profiles")
      .insert({ id: kim.data.user!.id, circle_wallet_id: "w2", wallet_address: data!.wallet_address });
    expect(dup.error?.code).toBe("23505");
  });
});
