import "../helpers/env";

import { beforeEach, describe, expect, it, vi } from "vitest";

const swap = vi.fn();
vi.mock("@circle-fin/app-kit", () => ({
  AppKit: class {
    swap = swap;
    estimateSwap = vi.fn();
  },
  SwapChain: { Arc_Testnet: "Arc_Testnet" },
}));
vi.mock("@circle-fin/adapter-circle-wallets", () => ({ createCircleWalletsAdapter: () => ({}) }));

async function run(feeBps: string, extra: Record<string, unknown> = {}) {
  process.env.APP_FEE_BPS = feeBps;
  vi.resetModules();
  const { executeSwap } = await import("@/lib/appkit/swap");
  swap.mockResolvedValue({ amountOut: "9", txHash: "0x1" });
  await executeSwap({ walletAddress: "0x1", tokenIn: "USDC", tokenOut: "EURC", amountIn: "10", slippageBps: 50, ...extra });
  return swap.mock.calls.at(-1)![0].config;
}

beforeEach(() => vi.resetAllMocks());

describe("executeSwap config", () => {
  it("sends the app fee as a percentage in basis points", async () => {
    const config = await run("25");
    expect(config.customFee).toEqual({ percentageBps: 25, recipientAddress: "0x000000000000000000000000000000000000dEaD" });
  });

  it("leaves the custom fee out when APP_FEE_BPS is 0: the SDK requires it to be above 0", async () => {
    const config = await run("0");
    expect(config).not.toHaveProperty("customFee");
  });

  it("passes slippage and the human-readable stop limit through", async () => {
    const config = await run("25", { stopLimit: "9.5" });
    expect(config).toMatchObject({ slippageBps: 50, stopLimit: "9.5" });
  });
});
