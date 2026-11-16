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

import { getFxBalances } from "@/lib/circle/wallets";
import { createRateLimiter } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Each refresh reads the wallet from Circle on the app's account.
const refreshLimiter = createRateLimiter({ limit: 20, windowMs: 60_000 });

export type RefreshState =
  | { ok: true; balances: { usdc: string; eurc: string } }
  | { ok: false; error: string };

export async function refreshBalances(): Promise<RefreshState> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: "Not authenticated" };

  const limited = refreshLimiter(user.id);
  if (!limited.ok) {
    return { ok: false, error: `Too many refreshes. Try again in ${limited.retryAfterSeconds}s.` };
  }

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("circle_wallet_id")
    .eq("id", user.id)
    .single();
  if (profileError || !profile) {
    return { ok: false, error: "Profile not found" };
  }

  try {
    const balances = await getFxBalances(profile.circle_wallet_id);
    const admin = createAdminClient();
    const { error } = await admin
      .from("wallet_balances")
      .upsert({
        user_id: user.id,
        usdc: balances.USDC,
        eurc: balances.EURC,
      });
    if (error) {
      console.error("[refreshBalances] could not save balances:", error.message);
      return { ok: false, error: "Could not save your balances. Please try again." };
    }
    return { ok: true, balances: { usdc: balances.USDC, eurc: balances.EURC } };
  } catch (err) {
    console.error("[refreshBalances] failed:", err instanceof Error ? err.message : err);
    return { ok: false, error: "Could not fetch your balances. Please try again." };
  }
}
