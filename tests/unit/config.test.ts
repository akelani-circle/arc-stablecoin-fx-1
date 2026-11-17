import "../helpers/env";

import { afterEach, describe, expect, it, vi } from "vitest";

const saved = { ...process.env };

async function load() {
  vi.resetModules();
  return import("@/lib/config");
}

afterEach(() => {
  process.env = { ...saved };
});

describe("serverEnv", () => {
  it("treats an empty CIRCLE_WEBHOOK_SECRET, as .env.example ships it, as not set", async () => {
    process.env.CIRCLE_WEBHOOK_SECRET = "";
    const { serverEnv } = await load();
    expect(serverEnv().CIRCLE_WEBHOOK_SECRET).toBeUndefined();
  });

  it("applies the defaults to blank values instead of using the blank", async () => {
    process.env.APP_FEE_BPS = "";
    process.env.CIRCLE_BLOCKCHAIN = "";
    const { serverEnv } = await load();
    expect(serverEnv()).toMatchObject({ APP_FEE_BPS: 25, CIRCLE_BLOCKCHAIN: "ARC-TESTNET" });
  });

  it("still rejects a blank required value", async () => {
    process.env.CIRCLE_API_KEY = "";
    const { serverEnv } = await load();
    expect(() => serverEnv()).toThrow(/CIRCLE_API_KEY/);
  });

  it("treats a blank APP_FEE_RECIPIENT as unset and charges no fee", async () => {
    process.env.APP_FEE_RECIPIENT = "";
    const { serverEnv, appFeeBps } = await load();
    expect(serverEnv().APP_FEE_RECIPIENT).toBeUndefined();
    expect(appFeeBps(serverEnv())).toBe(0);
  });

  it("keeps a webhook secret that is set", async () => {
    process.env.CIRCLE_WEBHOOK_SECRET = "s3cret";
    const { serverEnv } = await load();
    expect(serverEnv().CIRCLE_WEBHOOK_SECRET).toBe("s3cret");
  });
});

describe("clientEnv", () => {
  it("defaults a blank NEXT_PUBLIC_ARC_CHAIN", async () => {
    process.env.NEXT_PUBLIC_ARC_CHAIN = "";
    const { clientEnv } = await load();
    expect(clientEnv.NEXT_PUBLIC_ARC_CHAIN).toBe("Arc_Testnet");
  });
});
