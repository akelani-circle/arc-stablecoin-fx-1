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

// Import first: the app reads these when its config module loads.
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://127.0.0.1:54321";
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_test";
process.env.NEXT_PUBLIC_ARC_CHAIN = "Arc_Testnet";
process.env.SUPABASE_SECRET_KEY = "sb_secret_test";
process.env.CIRCLE_API_KEY = "TEST_API_KEY:aaaa:bbbb";
process.env.CIRCLE_ENTITY_SECRET = "0".repeat(64);
process.env.KIT_KEY = "KIT_KEY:test";
process.env.APP_FEE_BPS = "25";
process.env.APP_FEE_RECIPIENT = "0x000000000000000000000000000000000000dEaD";
delete process.env.CIRCLE_WEBHOOK_SECRET;
