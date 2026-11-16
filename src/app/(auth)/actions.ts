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

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";

import { createEOAWallet } from "@/lib/circle/wallets";
import { createRateLimiter } from "@/lib/rate-limit";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export type AuthState = { error?: string };

// Every sign-up creates a Circle wallet set and wallet on the app's account, and the form is
// open to anyone, so an unauthenticated script could otherwise create them without limit.
// Per client address, plus a global ceiling for when addresses are spoofed or rotated. In
// memory: it bounds one server instance (see src/lib/rate-limit.ts).
const signUpPerClient = createRateLimiter({ limit: 5, windowMs: 10 * 60_000 });
const signUpGlobal = createRateLimiter({ limit: 100, windowMs: 10 * 60_000 });

export async function signIn(_: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { error: error.message };

  redirect("/dashboard");
}

export async function signUp(_: AuthState, formData: FormData): Promise<AuthState> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const forwarded = (await headers()).get("x-forwarded-for");
  const client = forwarded?.split(",")[0]?.trim() || "unknown";
  if (!signUpPerClient(client).ok || !signUpGlobal("all").ok) {
    return { error: "Too many sign-ups right now. Please try again in a few minutes." };
  }

  const supabase = await createClient();
  const { data: signUpData, error: signUpError } = await supabase.auth.signUp(parsed.data);
  if (signUpError || !signUpData.user) {
    return { error: signUpError?.message ?? "Sign up failed" };
  }
  const userId = signUpData.user.id;

  const admin = createAdminClient();

  try {
    const wallet = await createEOAWallet(userId);

    const { error: profileError } = await admin.from("profiles").insert({
      id: userId,
      circle_wallet_id: wallet.id,
      // Lower-cased: the unique index is on lower(wallet_address), and lookups compare lower-case.
      wallet_address: wallet.address.toLowerCase(),
    });
    if (profileError) throw new Error(profileError.message);

    const { error: balanceError } = await admin
      .from("wallet_balances")
      .insert({ user_id: userId });
    if (balanceError) throw new Error(balanceError.message);
  } catch (err) {
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    // The raw message can carry Circle request details; log it, show something generic.
    console.error("[signUp] wallet provisioning failed:", err instanceof Error ? err.message : err);
    return { error: "We could not set up your wallet. Please try again in a moment." };
  }

  redirect("/dashboard");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
