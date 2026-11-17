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

import { z } from "zod";

const serverSchema = z.object({
  CIRCLE_API_KEY: z.string().min(1),
  CIRCLE_ENTITY_SECRET: z.string().regex(/^[0-9a-f]{64}$/, "must be 32 bytes hex (64 chars)"),
  CIRCLE_BLOCKCHAIN: z.string().default("ARC-TESTNET"),
  CIRCLE_WEBHOOK_SECRET: z.string().min(1).optional(),
  APP_FEE_BPS: z.coerce.number().int().min(0).max(10_000).default(25),
  // Optional: a blank value (as in .env.example) counts as unset, see withoutEmpty below.
  APP_FEE_RECIPIENT: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, "must be a 0x-prefixed EVM address")
    .optional(),
  SUPABASE_SECRET_KEY: z.string().min(1),
});

const clientSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  NEXT_PUBLIC_ARC_CHAIN: z.string().default("Arc_Testnet"),
});

// An empty value (`CIRCLE_WEBHOOK_SECRET=`, as .env.example ships it) means "not set". Without
// this, an optional variable left blank failed validation and took every server feature down,
// and a blank variable with a default never got its default.
function withoutEmpty(env: Record<string, string | undefined>) {
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
}

let cachedServer: z.infer<typeof serverSchema> | null = null;

export function serverEnv() {
  if (cachedServer) return cachedServer;
  const parsed = serverSchema.safeParse(withoutEmpty(process.env));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid server environment:\n${issues}`);
  }
  cachedServer = parsed.data;
  return cachedServer;
}

// The fee is only charged when there's a recipient to send it to.
export function appFeeBps(env: z.infer<typeof serverSchema>) {
  return env.APP_FEE_RECIPIENT ? env.APP_FEE_BPS : 0;
}

export const clientEnv = clientSchema.parse(
  withoutEmpty({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    NEXT_PUBLIC_ARC_CHAIN: process.env.NEXT_PUBLIC_ARC_CHAIN,
  }),
);
