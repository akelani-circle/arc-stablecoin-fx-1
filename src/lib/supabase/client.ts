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

import { createBrowserClient } from "@supabase/ssr";
import type { RealtimeChannel } from "@supabase/supabase-js";

export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
  );
}

/**
 * Subscribes to a Realtime channel as the signed-in user, and returns the cleanup for an effect.
 *
 * A channel joins with whatever token Realtime holds when `subscribe()` runs. The browser client
 * hands it the user's token only once the session has loaded, so a channel opened straight away
 * joined as `anon`, which has no grants on these tables, and never received a change. Realtime
 * keeps the token current itself after that (sign-in, refresh, sign-out).
 */
export function subscribeAsUser(
  supabase: ReturnType<typeof createClient>,
  build: () => RealtimeChannel,
): () => void {
  let channel: RealtimeChannel | null = null;
  let closed = false;
  // The token is passed in rather than fetched by setAuth() itself: with no argument, a call that
  // overlaps another one (several components mount at once) can return before the token is set.
  void supabase.auth
    .getSession()
    .then(({ data }) => supabase.realtime.setAuth(data.session?.access_token ?? null))
    .catch((err: unknown) => console.warn("[realtime] could not load the session:", err))
    .then(() => {
      if (!closed) channel = build().subscribe();
    });
  return () => {
    closed = true;
    if (channel) void supabase.removeChannel(channel);
  };
}
