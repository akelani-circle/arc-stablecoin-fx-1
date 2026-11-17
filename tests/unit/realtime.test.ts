import { beforeEach, describe, expect, it, vi } from "vitest";

import { subscribeAsUser } from "@/lib/supabase/client";

type Client = Parameters<typeof subscribeAsUser>[0];
type Channel = ReturnType<Parameters<typeof subscribeAsUser>[1]>;

const order: string[] = [];
const channel = { subscribe: vi.fn(() => (order.push("subscribe"), channel)) };
const supabase = {
  auth: { getSession: vi.fn() },
  realtime: { setAuth: vi.fn(async (token: string | null) => void order.push(`setAuth:${token}`)) },
  removeChannel: vi.fn(async () => "ok"),
};
const client = supabase as unknown as Client;
const build = () => channel as unknown as Channel;
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  order.length = 0;
  vi.clearAllMocks();
  supabase.auth.getSession.mockResolvedValue({ data: { session: { access_token: "user-jwt" } } });
});

describe("subscribeAsUser", () => {
  it("gives Realtime the user's token before the channel joins", async () => {
    subscribeAsUser(client, build);
    expect(channel.subscribe).not.toHaveBeenCalled();
    await settle();
    expect(order).toEqual(["setAuth:user-jwt", "subscribe"]);
  });

  it("removes the channel on cleanup", async () => {
    const cleanup = subscribeAsUser(client, build);
    await settle();
    cleanup();
    expect(supabase.removeChannel).toHaveBeenCalledWith(channel);
  });

  it("never opens the channel when cleaned up before the session loads", async () => {
    const cleanup = subscribeAsUser(client, build);
    cleanup();
    await settle();
    expect(channel.subscribe).not.toHaveBeenCalled();
    expect(supabase.removeChannel).not.toHaveBeenCalled();
  });

  it("still subscribes when the session cannot be read", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    supabase.auth.getSession.mockRejectedValue(new Error("offline"));
    subscribeAsUser(client, build);
    await settle();
    expect(channel.subscribe).toHaveBeenCalled();
  });
});
