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

import { after } from "next/server";
import { z } from "zod";

import { getFxBalances } from "@/lib/circle/wallets";
import { safeEqual, verifyCircleSignature } from "@/lib/circle/webhook-signature";
import { serverEnv } from "@/lib/config";
import { createAdminClient } from "@/lib/supabase/admin";

// Circle sends a HEAD request to verify the endpoint is reachable.
export function HEAD() {
  return new Response(null, { status: 200 });
}

const notificationSchema = z.object({
  notificationType: z.string(),
  notification: z
    .object({
      walletId: z.string().optional(),
      destinationAddress: z.string().optional(),
      state: z.string().optional(),
    })
    .passthrough(),
});

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export async function POST(request: Request) {
  const env = serverEnv();

  // Circle signs every notification. The old check only compared a bearer token, and only if
  // CIRCLE_WEBHOOK_SECRET happened to be set (it is optional, and Circle does not send one),
  // so by default anyone could post notifications. The signature is now always required.
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const verified = await verifyCircleSignature(
    rawBody,
    request.headers.get("x-circle-signature"),
    request.headers.get("x-circle-key-id"),
    env.CIRCLE_API_KEY,
  );
  if (!verified) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Optional extra layer, for deployments that put a secret in front of the endpoint.
  if (env.CIRCLE_WEBHOOK_SECRET) {
    const auth = request.headers.get("Authorization") ?? "";
    if (!safeEqual(auth, `Bearer ${env.CIRCLE_WEBHOOK_SECRET}`)) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const parsed = notificationSchema.safeParse(body);
  if (!parsed.success) {
    return new Response("OK", { status: 200 });
  }

  const { notificationType, notification } = parsed.data;

  // CONFIRMED = balance already credited by Circle (soft finality on L2s like Arc Testnet).
  // COMPLETE  = final settlement. Handle both so we never miss an update. Circle's reference
  // lists the state as COMPLETE, but its webhook guide and example payload say COMPLETED, so
  // both spellings are accepted.
  const isSettled =
    notification.state === "CONFIRMED" ||
    notification.state === "COMPLETE" ||
    notification.state === "COMPLETED";

  if (notificationType === "transactions.inbound" && isSettled) {
    // Circle gives the endpoint 5 seconds to answer. The refresh calls Circle and the
    // database, so it runs after the response is sent. It is idempotent (it stores the
    // current balance), so a repeated notification does no harm.
    const { walletId, destinationAddress } = notification;
    after(() => handleInboundComplete(walletId, destinationAddress));
  }

  return new Response("OK", { status: 200 });
}

async function handleInboundComplete(walletId?: string, destinationAddress?: string) {
  if (!walletId && !destinationAddress) return;

  try {
    const admin = createAdminClient();

    // Try Circle wallet UUID first, fall back to on-chain address.
    let profile: { id: string; circle_wallet_id: string } | null = null;

    if (walletId) {
      const { data } = await admin
        .from("profiles")
        .select("id, circle_wallet_id")
        .eq("circle_wallet_id", walletId)
        .maybeSingle();
      profile = data ?? null;
    }

    // ilike, because rows written before addresses were lower-cased may be mixed case. The
    // value is checked to be plain hex first: % and _ are wildcards in LIKE.
    if (!profile && destinationAddress && ADDRESS.test(destinationAddress)) {
      const { data } = await admin
        .from("profiles")
        .select("id, circle_wallet_id")
        .ilike("wallet_address", destinationAddress)
        .maybeSingle();
      profile = data ?? null;
    }

    if (!profile) return;

    const balances = await getFxBalances(profile.circle_wallet_id);

    const { error: upsertError } = await admin.from("wallet_balances").upsert({
      user_id: profile.id,
      usdc: balances.USDC,
      eurc: balances.EURC,
    });
    if (upsertError) {
      console.error("[webhook/circle] balance upsert failed:", upsertError.message);
    }
  } catch (err) {
    console.error("[webhook/circle] balance update failed:", err instanceof Error ? err.message : err);
  }
}
