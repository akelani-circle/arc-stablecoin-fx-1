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

/**
 * Turns an error from Circle, App Kit or the database into something safe to show. Raw SDK
 * errors can carry request details, identifiers and stack fragments, and swap failures are
 * also stored on the row the user can read. Unrecognised errors become a generic message;
 * the original is logged on the server.
 */
export function toUserFacingError(error: unknown, fallback = "The swap could not be completed. Please try again."): string {
  const msg = (error instanceof Error ? error.message : typeof error === "string" ? error : "").toLowerCase();

  if (/insufficient (funds|balance)|exceeds (the )?balance|not enough/.test(msg)) {
    return "Insufficient balance for this swap.";
  }
  if (/slippage|price impact|stop ?limit|min(imum)? (out|received|amount)/.test(msg)) {
    return "The price moved beyond your slippage limit. Try again or raise the limit.";
  }
  if (/gas|intrinsic|fee/.test(msg)) {
    return "The network fee could not be paid. Check your balance and try again.";
  }
  if (/rate limit|too many requests|429/.test(msg)) {
    return "Too many requests. Please wait a moment and try again.";
  }
  if (/network|timeout|timed out|econn|fetch failed|rpc/.test(msg)) {
    return "Network error. Please try again.";
  }
  return fallback;
}
