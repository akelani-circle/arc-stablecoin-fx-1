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

const userClient = { auth: { getUser: vi.fn(), signUp: vi.fn() }, from: vi.fn() };
const adminClient = { from: vi.fn(), auth: { admin: { deleteUser: vi.fn() } } };
const getFxBalances = vi.fn();
const createEOAWallet = vi.fn();
const headerStore = new Headers();
const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});

vi.mock("@/lib/supabase/server", () => ({ createClient: async () => userClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => adminClient }));
vi.mock("@/lib/circle/wallets", () => ({ getFxBalances, createEOAWallet }));
vi.mock("next/headers", () => ({ headers: async () => headerStore }));
vi.mock("next/navigation", () => ({ redirect }));

const USER = { id: "11111111-1111-4111-8111-111111111111" };

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  redirect.mockImplementation((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  });
  headerStore.delete("x-forwarded-for");
});

describe("refreshBalances", () => {
  async function load() {
    vi.resetModules();
    return import("@/app/(app)/actions");
  }

  it("requires a signed-in user", async () => {
    userClient.auth.getUser.mockResolvedValue({ data: { user: null } });
    const { refreshBalances } = await load();
    expect(await refreshBalances()).toEqual({ ok: false, error: "Not authenticated" });
    expect(getFxBalances).not.toHaveBeenCalled();
  });

  it("reads the caller's own wallet and stores the balances", async () => {
    userClient.auth.getUser.mockResolvedValue({ data: { user: USER } });
    const profiles = queryBuilder({ data: { circle_wallet_id: "wallet-1" } });
    queueTables(userClient, { profiles: [profiles] });
    const balances = queryBuilder();
    queueTables(adminClient, { wallet_balances: [balances] });
    getFxBalances.mockResolvedValue({ USDC: "5", EURC: "6" });
    const { refreshBalances } = await load();

    expect(await refreshBalances()).toEqual({ ok: true, balances: { usdc: "5", eurc: "6" } });
    expect(profiles.eq).toHaveBeenCalledWith("id", USER.id);
    expect(getFxBalances).toHaveBeenCalledWith("wallet-1");
    expect(balances.upsert).toHaveBeenCalledWith({ user_id: USER.id, usdc: "5", eurc: "6" });
  });

  it("does not leak Circle or database error text", async () => {
    userClient.auth.getUser.mockResolvedValue({ data: { user: USER } });
    queueTables(userClient, { profiles: [queryBuilder({ data: { circle_wallet_id: "wallet-1" } })] });
    getFxBalances.mockRejectedValue(new Error("401 apiKey=TEST_API_KEY:aaaa:bbbb"));
    const { refreshBalances } = await load();
    const result = await refreshBalances();
    expect(result).toEqual({ ok: false, error: "Could not fetch your balances. Please try again." });

    queueTables(userClient, { profiles: [queryBuilder({ data: { circle_wallet_id: "wallet-1" } })] });
    queueTables(adminClient, { wallet_balances: [queryBuilder({ error: { message: 'permission denied for table "wallet_balances"' } })] });
    getFxBalances.mockResolvedValue({ USDC: "1", EURC: "1" });
    expect(await refreshBalances()).toEqual({ ok: false, error: "Could not save your balances. Please try again." });
  });

  it("rate limits a user to 20 refreshes a minute", async () => {
    userClient.auth.getUser.mockResolvedValue({ data: { user: USER } });
    userClient.from.mockImplementation(() => queryBuilder({ data: { circle_wallet_id: "wallet-1" } }));
    adminClient.from.mockImplementation(() => queryBuilder());
    getFxBalances.mockResolvedValue({ USDC: "1", EURC: "1" });
    const { refreshBalances } = await load();
    for (let i = 0; i < 20; i++) expect((await refreshBalances()).ok).toBe(true);
    const blocked = await refreshBalances();
    expect(blocked.ok).toBe(false);
    expect(!blocked.ok && blocked.error).toMatch(/Too many refreshes/);
    expect(getFxBalances).toHaveBeenCalledTimes(20);
  });
});

describe("signUp", () => {
  async function load() {
    vi.resetModules();
    return import("@/app/(auth)/actions");
  }

  function form(email = "a@example.com", password = "correct horse") {
    const f = new FormData();
    f.set("email", email);
    f.set("password", password);
    return f;
  }

  function happyPath() {
    userClient.auth.signUp.mockResolvedValue({ data: { user: USER }, error: null });
    createEOAWallet.mockResolvedValue({ id: "wallet-1", address: "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01", walletSetId: "ws" });
    const profiles = queryBuilder();
    const balances = queryBuilder();
    queueTables(adminClient, { profiles: [profiles], wallet_balances: [balances] });
    return { profiles, balances };
  }

  it("stores the wallet address lower-cased", async () => {
    const { profiles } = happyPath();
    const { signUp } = await load();
    await expect(signUp({}, form())).rejects.toThrow("NEXT_REDIRECT:/dashboard");
    expect(profiles.insert).toHaveBeenCalledWith({
      id: USER.id,
      circle_wallet_id: "wallet-1",
      wallet_address: "0xabcdef0123456789abcdef0123456789abcdef01",
    });
  });

  it("rolls back the auth user and hides the cause when provisioning fails", async () => {
    userClient.auth.signUp.mockResolvedValue({ data: { user: USER }, error: null });
    createEOAWallet.mockRejectedValue(new Error("Circle 401: apiKey=TEST_API_KEY:aaaa:bbbb entitySecret=..."));
    adminClient.auth.admin.deleteUser.mockResolvedValue({});
    const { signUp } = await load();
    const result = await signUp({}, form());
    expect(result).toEqual({ error: "We could not set up your wallet. Please try again in a moment." });
    expect(adminClient.auth.admin.deleteUser).toHaveBeenCalledWith(USER.id);
  });

  it("rejects weak input before creating anything", async () => {
    const { signUp } = await load();
    expect((await signUp({}, form("not-an-email"))).error).toBeDefined();
    expect((await signUp({}, form("a@example.com", "short"))).error).toBe("Password must be at least 8 characters");
    expect(userClient.auth.signUp).not.toHaveBeenCalled();
    expect(createEOAWallet).not.toHaveBeenCalled();
  });

  it("limits sign-ups per client address before spending Circle quota", async () => {
    headerStore.set("x-forwarded-for", "203.0.113.7, 10.0.0.1");
    userClient.auth.signUp.mockResolvedValue({ data: { user: null }, error: { message: "nope" } });
    const { signUp } = await load();
    for (let i = 0; i < 5; i++) expect((await signUp({}, form())).error).toBe("nope");
    expect((await signUp({}, form())).error).toMatch(/Too many sign-ups/);
    expect(userClient.auth.signUp).toHaveBeenCalledTimes(5);

    // A different address is not affected.
    headerStore.set("x-forwarded-for", "203.0.113.8");
    expect((await signUp({}, form())).error).toBe("nope");
  });

  it("caps sign-ups globally, whatever the addresses claim to be", async () => {
    userClient.auth.signUp.mockResolvedValue({ data: { user: null }, error: { message: "nope" } });
    const { signUp } = await load();
    for (let i = 0; i < 100; i++) {
      // Distinct first hops: each is under its own per-client limit.
      headerStore.set("x-forwarded-for", `10.${Math.floor(i / 250)}.${i % 250}.1`);
      expect((await signUp({}, form())).error).toBe("nope");
    }
    headerStore.set("x-forwarded-for", "192.0.2.1");
    expect((await signUp({}, form())).error).toMatch(/Too many sign-ups/);
  });
});
