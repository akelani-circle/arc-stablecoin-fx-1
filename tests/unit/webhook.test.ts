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

import { createSign, generateKeyPairSync } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { queryBuilder, queueTables } from "../helpers/supabase-mock";

const adminClient = { from: vi.fn() };
const getFxBalances = vi.fn();
const fetchMock = vi.fn();

// Outside a Next.js request, after() throws; run the callback ourselves and let tests await it.
const afterTasks: Promise<unknown>[] = [];
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => unknown) => {
    afterTasks.push(Promise.resolve().then(task));
  },
}));
const flush = async () => {
  await Promise.all(afterTasks.splice(0));
};

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => adminClient }));
vi.mock("@/lib/circle/wallets", () => ({ getFxBalances }));

// Circle signs the raw body with an EC key and publishes the public key as base64 DER.
const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const PUBLIC_KEY_B64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const OTHER_KEY = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;

const KEY_ID = "11111111-2222-4333-8444-555555555555";
const WALLET_ID = "circle-wallet-1";
const ADDRESS = "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01";

function sign(body: string, key = privateKey) {
  return createSign("SHA256").update(body).end().sign(key).toString("base64");
}

function inbound(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    notificationType: "transactions.inbound",
    notification: { walletId: WALLET_ID, destinationAddress: ADDRESS, state: "COMPLETE", ...overrides },
  });
}

function request(body: string, headers: Record<string, string | undefined> = {}) {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (v !== undefined) h[k] = v;
  return new Request("http://localhost/api/webhooks/circle", { method: "POST", headers: h, body });
}

function signed(body: string, extra: Record<string, string> = {}) {
  return request(body, { "x-circle-signature": sign(body), "x-circle-key-id": KEY_ID, ...extra });
}

async function route() {
  vi.resetModules();
  return import("@/app/api/webhooks/circle/route");
}

beforeEach(async () => {
  vi.resetAllMocks();
  afterTasks.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  delete process.env.CIRCLE_WEBHOOK_SECRET;
  fetchMock.mockResolvedValue(Response.json({ data: { publicKey: PUBLIC_KEY_B64 } }));
  vi.stubGlobal("fetch", fetchMock);
  getFxBalances.mockResolvedValue({ USDC: "12.5", EURC: "3" });
  const { clearKeyCache } = await import("@/lib/circle/webhook-signature");
  clearKeyCache();
});

describe("Circle webhook: authentication", () => {
  it("rejects an unsigned request (the old code accepted it when no secret was set)", async () => {
    const { POST } = await route();
    const res = await POST(request(inbound()));
    expect(res.status).toBe(401);
    expect(adminClient.from).not.toHaveBeenCalled();
    expect(getFxBalances).not.toHaveBeenCalled();
  });

  it("rejects a signature made with a different key", async () => {
    const { POST } = await route();
    const body = inbound();
    const res = await POST(request(body, { "x-circle-signature": sign(body, OTHER_KEY), "x-circle-key-id": KEY_ID }));
    expect(res.status).toBe(401);
    expect(getFxBalances).not.toHaveBeenCalled();
  });

  it("rejects a body that was changed after signing", async () => {
    const { POST } = await route();
    const original = inbound({ walletId: "victim-wallet" });
    const tampered = inbound({ walletId: "attacker-wallet" });
    const res = await POST(request(tampered, { "x-circle-signature": sign(original), "x-circle-key-id": KEY_ID }));
    expect(res.status).toBe(401);
  });

  it("verifies the raw bytes, not a re-serialisation of the JSON", async () => {
    const { POST } = await route();
    // Same JSON value, different bytes: extra whitespace. A signature over the compact
    // form must not validate the padded one.
    const compact = inbound();
    const padded = JSON.stringify(JSON.parse(compact), null, 2);
    const res = await POST(request(padded, { "x-circle-signature": sign(compact), "x-circle-key-id": KEY_ID }));
    expect(res.status).toBe(401);
  });

  it("accepts exactly the bytes that were signed, including trailing whitespace", async () => {
    adminClient.from.mockImplementation(() => queryBuilder({ data: null }));
    const { POST } = await route();
    const body = inbound() + "\n  ";
    expect((await POST(signed(body))).status).toBe(200);
  });

  it("does not keep a garbage key: it is looked up again once the failure window passes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      adminClient.from.mockImplementation(() => queryBuilder({ data: null }));
      fetchMock.mockResolvedValueOnce(Response.json({ data: { publicKey: "AAAA" } }));
      const { POST } = await route();
      expect((await POST(signed(inbound()))).status).toBe(401);

      vi.advanceTimersByTime(61_000);
      expect((await POST(signed(inbound()))).status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a missing key id or signature", async () => {
    const { POST } = await route();
    const body = inbound();
    expect((await POST(request(body, { "x-circle-signature": sign(body) }))).status).toBe(401);
    expect((await POST(request(body, { "x-circle-key-id": KEY_ID }))).status).toBe(401);
  });

  it("rejects a malformed signature without throwing", async () => {
    const { POST } = await route();
    const res = await POST(request(inbound(), { "x-circle-signature": "not base64 !!!", "x-circle-key-id": KEY_ID }));
    expect(res.status).toBe(401);
  });

  it("does not call Circle for a key id that is not in the expected format", async () => {
    const { POST } = await route();
    const body = inbound();
    const res = await POST(request(body, { "x-circle-signature": sign(body), "x-circle-key-id": "../../v1/w3s/wallets" }));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when Circle's key endpoint is unavailable", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    const { POST } = await route();
    expect((await POST(signed(inbound()))).status).toBe(401);
    expect(getFxBalances).not.toHaveBeenCalled();
  });

  it("fails closed when Circle returns a key that is not a valid key", async () => {
    fetchMock.mockResolvedValue(Response.json({ data: { publicKey: "AAAA" } }));
    const { POST } = await route();
    expect((await POST(signed(inbound()))).status).toBe(401);
  });

  it("looks the key up once and reuses it", async () => {
    adminClient.from.mockImplementation(() => queryBuilder({ data: null }));
    const { POST } = await route();
    await POST(signed(inbound()));
    await POST(signed(inbound()));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://api.circle.com/v2/notifications/publicKey/${KEY_ID}`);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe("Bearer TEST_API_KEY:aaaa:bbbb");
  });

  it("does not hammer Circle when the same bad key id keeps arriving", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 404 }));
    const { POST } = await route();
    for (let i = 0; i < 5; i++) await POST(signed(inbound()));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  describe("with CIRCLE_WEBHOOK_SECRET set", () => {
    it("also requires the bearer secret", async () => {
      process.env.CIRCLE_WEBHOOK_SECRET = "s3cret-value";
      const { POST } = await route();
      expect((await POST(signed(inbound()))).status).toBe(401);
      expect((await POST(signed(inbound(), { Authorization: "Bearer wrong" }))).status).toBe(401);
      expect(getFxBalances).not.toHaveBeenCalled();
    });

    it("accepts a valid signature plus the right secret", async () => {
      process.env.CIRCLE_WEBHOOK_SECRET = "s3cret-value";
      adminClient.from.mockImplementation(() => queryBuilder({ data: null }));
      const { POST } = await route();
      expect((await POST(signed(inbound(), { Authorization: "Bearer s3cret-value" }))).status).toBe(200);
    });

    it("does not accept the secret without a signature", async () => {
      process.env.CIRCLE_WEBHOOK_SECRET = "s3cret-value";
      const { POST } = await route();
      const res = await POST(request(inbound(), { Authorization: "Bearer s3cret-value" }));
      expect(res.status).toBe(401);
    });
  });
});

describe("Circle webhook: handling", () => {
  it("answers HEAD for Circle's reachability check", async () => {
    const { HEAD } = await route();
    expect(HEAD().status).toBe(200);
  });

  it("returns 400 for a signed body that is not JSON", async () => {
    const { POST } = await route();
    expect((await POST(signed("not json"))).status).toBe(400);
  });

  it("ignores a signed body that has an unexpected shape", async () => {
    const { POST } = await route();
    const res = await POST(signed(JSON.stringify({ hello: "world" })));
    expect(res.status).toBe(200);
    expect(adminClient.from).not.toHaveBeenCalled();
  });

  it.each(["CONFIRMED", "COMPLETE", "COMPLETED"])("refreshes the balance of the wallet owner when the state is %s", async (state) => {
    const profiles = queryBuilder({ data: { id: "user-1", circle_wallet_id: WALLET_ID } });
    const balances = queryBuilder();
    queueTables(adminClient, { profiles: [profiles], wallet_balances: [balances] });
    const { POST } = await route();

    const res = await POST(signed(inbound({ state })));
    await flush();

    expect(res.status).toBe(200);
    expect(profiles.eq).toHaveBeenCalledWith("circle_wallet_id", WALLET_ID);
    expect(getFxBalances).toHaveBeenCalledWith(WALLET_ID);
    expect(balances.upsert).toHaveBeenCalledWith({ user_id: "user-1", usdc: "12.5", eurc: "3" });
  });

  it.each(["PENDING", "FAILED", "QUEUED", undefined])("ignores state %s", async (state) => {
    const { POST } = await route();
    const res = await POST(signed(inbound({ state })));
    expect(res.status).toBe(200);
    expect(adminClient.from).not.toHaveBeenCalled();
    expect(getFxBalances).not.toHaveBeenCalled();
  });

  it("ignores other notification types", async () => {
    const { POST } = await route();
    const res = await POST(signed(JSON.stringify({ notificationType: "transactions.outbound", notification: { walletId: WALLET_ID, state: "COMPLETE" } })));
    expect(res.status).toBe(200);
    expect(adminClient.from).not.toHaveBeenCalled();
  });

  it("falls back to the destination address, case-insensitively, when the wallet id is unknown", async () => {
    const byId = queryBuilder({ data: null });
    const byAddress = queryBuilder({ data: { id: "user-2", circle_wallet_id: "circle-wallet-2" } });
    const balances = queryBuilder();
    queueTables(adminClient, { profiles: [byId, byAddress], wallet_balances: [balances] });
    const { POST } = await route();

    await POST(signed(inbound()));
    await flush();

    expect(byAddress.ilike).toHaveBeenCalledWith("wallet_address", ADDRESS);
    expect(getFxBalances).toHaveBeenCalledWith("circle-wallet-2");
    expect(balances.upsert).toHaveBeenCalledWith(expect.objectContaining({ user_id: "user-2" }));
  });

  it("never puts a non-address destination into an ILIKE pattern", async () => {
    const byId = queryBuilder({ data: null });
    queueTables(adminClient, { profiles: [byId] });
    const { POST } = await route();
    // "%" would match every profile.
    const res = await POST(signed(inbound({ destinationAddress: "%" })));
    await flush();
    expect(res.status).toBe(200);
    expect(adminClient.from).toHaveBeenCalledTimes(1);
    expect(getFxBalances).not.toHaveBeenCalled();
  });

  it("does nothing when no profile matches", async () => {
    adminClient.from.mockImplementation(() => queryBuilder({ data: null }));
    const { POST } = await route();
    expect((await POST(signed(inbound()))).status).toBe(200);
    await flush();
    expect(getFxBalances).not.toHaveBeenCalled();
  });

  it("still answers 200 when the balance lookup fails, so Circle does not retry forever", async () => {
    queueTables(adminClient, { profiles: [queryBuilder({ data: { id: "user-1", circle_wallet_id: WALLET_ID } })] });
    getFxBalances.mockRejectedValue(new Error("circle down"));
    const { POST } = await route();
    expect((await POST(signed(inbound()))).status).toBe(200);
    await expect(flush()).resolves.toBeUndefined();
  });

  it("answers within Circle's 5 second limit: the refresh runs after the response", async () => {
    queueTables(adminClient, { profiles: [queryBuilder({ data: { id: "user-1", circle_wallet_id: WALLET_ID } })], wallet_balances: [queryBuilder()] });
    let finish!: (v: { USDC: string; EURC: string }) => void;
    getFxBalances.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { POST } = await route();

    // getFxBalances has not resolved, yet the response is already here.
    const res = await POST(signed(inbound()));
    expect(res.status).toBe(200);

    finish({ USDC: "1", EURC: "2" });
    await flush();
    expect(getFxBalances).toHaveBeenCalledWith(WALLET_ID);
  });

  it("accepts the COMPLETED spelling used in Circle's webhook guide", async () => {
    queueTables(adminClient, { profiles: [queryBuilder({ data: { id: "user-1", circle_wallet_id: WALLET_ID } })], wallet_balances: [queryBuilder()] });
    const { POST } = await route();
    await POST(signed(inbound({ state: "COMPLETED" })));
    await flush();
    expect(getFxBalances).toHaveBeenCalledWith(WALLET_ID);
  });
});
