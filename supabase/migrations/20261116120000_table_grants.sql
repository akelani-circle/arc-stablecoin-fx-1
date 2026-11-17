-- Copyright 2026 Circle Internet Group, Inc.  All rights reserved.
--
-- Licensed under the Apache License, Version 2.0 (the "License");
-- you may not use this file except in compliance with the License.
-- You may obtain a copy of the License at
--
--     http://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing, software
-- distributed under the License is distributed on an "AS IS" BASIS,
-- WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
-- See the License for the specific language governing permissions and
-- limitations under the License.
--
-- SPDX-License-Identifier: Apache-2.0

-- Grant table access explicitly. Older Supabase Postgres images granted it by default on new
-- tables, and the app relied on that. Newer ones (from Supabase CLI 2.109.1 on) do not, so the
-- server's secret key could not read or write these tables, and signed-in users could not read
-- their own rows. These are the same grants the older images gave, so this changes nothing
-- where they are already in place.

grant select on table public.profiles, public.swaps, public.wallet_balances to authenticated;

grant select, insert, update, delete
  on table public.profiles, public.swaps, public.wallet_balances
  to service_role;
