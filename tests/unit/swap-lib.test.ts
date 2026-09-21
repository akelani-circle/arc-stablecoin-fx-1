import "../helpers/env";

import { beforeEach, describe, expect, it, vi } from "vitest";

const swap = vi.fn();
const estimate = vi.fn();
// doMock, not mock: each test resets modules and needs the mocks in place for its own import.
function mockSdk() {
  vi.doMock("@circle-fin/app-kit", () => ({
    AppKit: class {
      swap = swap;
      estimateSwap = estimate;
    },
    SwapChain: { Arc_Testnet: "Arc_Testnet" },
  }));
  vi.doMock("@circle-fin/adapter-circle-wallets", () => ({ createCircleWalletsAdapter: () => ({}) }));
}

async function run(feeBps: string, extra: Record<string, unknown> = {}) {
  process.env.APP_FEE_BPS = feeBps;
  vi.resetModules();
  mockSdk();
  const { executeSwap } = await import("@/lib/appkit/swap");
  swap.mockResolvedValue({ amountOut: "9", txHash: "0x1" });
  await executeSwap({ walletAddress: "0x1", tokenIn: "USDC", tokenOut: "EURC", amountIn: "10", slippageBps: 50, ...extra });
  return swap.mock.calls.at(-1)![0].config;
}

beforeEach(() => vi.resetAllMocks());

describe("swap authentication", () => {
  it("uses the Circle API key for swaps", async () => {
    const config = await run("25");
    expect(config.apiKey).toBe("TEST_API_KEY:aaaa:bbbb");
  });

  it("uses the Circle API key for quotes", async () => {
    estimate.mockResolvedValue({ estimatedOutput: { amount: "9" } });
    vi.resetModules();
    mockSdk();
    const { estimateSwap } = await import("@/lib/appkit/swap");
    await estimateSwap({ walletAddress: "0x1", tokenIn: "USDC", tokenOut: "EURC", amountIn: "10" });
    expect(estimate.mock.calls[0][0].config).toEqual({ apiKey: "TEST_API_KEY:aaaa:bbbb" });
  });
});

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
