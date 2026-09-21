# Arc Stablecoin FX

This sample app demonstrates stablecoin FX swaps between USDC and EURC using the App Kits Swap SDK and Circle Developer Controlled Wallets on Arc.

<img alt="Arc Stablecoin Fx" src="public/screenshot.png" />

## Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Getting Started](#getting-started)
- [How It Works](#how-it-works)
- [Project Layout](#project-layout)
- [Environment Variables](#environment-variables)
- [Testing](#testing)
- [Upgrading](#upgrading)
- [Security & Usage Model](#security--usage-model)

## Features

- **Sign up / sign in** (`register`/`login`) — Supabase-authenticated accounts tied to a Circle Developer-Controlled Wallet.
- **Swap panel** (`SwapPanel`) — convert between USDC and EURC via the App Kit Swap SDK, with the platform fee applied automatically.
- **Trade history** (`TradesTable`) — past swaps for the signed-in user.
- **Wallet header** (`HeaderWallet`, `WalletAddressCopy`) — shows the user's Circle wallet address and balance, copyable to clipboard.
- **Webhook-driven balance sync** (`/api/webhooks/circle`) — Circle inbound-transaction notifications update cached balances in Supabase.

## Prerequisites

- Node.js 20+ and npm
- Docker (for local Supabase)
- A [Circle](https://console.circle.com) account with API key + entity secret
- A Circle App Kit `KIT_KEY`

## Getting Started

1. Install dependencies:

   ```sh
   npm install
   ```

2. Start the local Supabase stack:

   ```sh
   npm run db:start
   ```

   This boots Postgres, Auth, etc. via the Supabase CLI and runs the migrations in
   `supabase/migrations/`. Use `npm run db:status` to print the local URLs and keys,
   `npm run db:reset` to wipe + re-migrate, and `npm run db:stop` to shut it down.

3. Set up environment variables:

   ```sh
   cp .env.example .env.local
   ```

   Then edit `.env.local` and fill in all required values (see [Environment Variables](#environment-variables) below). `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` / `SUPABASE_SECRET_KEY` come from `npm run db:status`.

4. Provision the platform fee wallet:

   ```sh
   npm run wallet:generate
   ```

   Creates a Circle wallet to receive swap fees and writes its address back to `.env.local` as `APP_FEE_RECIPIENT`.

5. Start the dev server:

   ```sh
   npm run dev
   ```

   The app will be available at [http://localhost:3000](http://localhost:3000).

## How It Works

- Built with [Next.js](https://nextjs.org/) App Router and [Supabase](https://supabase.com/) (auth + trade history)
- Uses [Circle Developer Controlled Wallets](https://developers.circle.com/wallets/dev-controlled) to hold each user's USDC/EURC
- Utilizes `@circle-fin/app-kit`'s Swap SDK (`kit.swap` / `kit.estimateSwap`) for USDC ⇄ EURC swaps on Arc Testnet
- A platform-level fee (`APP_FEE_BPS`) is applied to every swap and routed to `APP_FEE_RECIPIENT`, a Circle wallet provisioned via `npm run wallet:generate`
- [Circle webhooks](https://developers.circle.com/api-reference/webhook-endpoints) (`/api/webhooks/circle`) keep cached wallet balances in Supabase in sync with on-chain settlement
- Styled with [Tailwind CSS](https://tailwindcss.com) and components from [shadcn/ui](https://ui.shadcn.com/)

## Project Layout

- `src/app/(auth)/` - register / login flows
- `src/app/(app)/dashboard/` - authenticated swap panel
- `src/app/(app)/dashboard/history/` - trades history
- `src/app/api/webhooks/circle/` - Circle webhook receiver
- `src/components/swap/`, `src/components/trades/`, `src/components/wallet/` - feature UI
- `src/lib/circle/`, `src/lib/appkit/` - Circle wallets + App Kit integration
- `src/lib/supabase/` - Supabase client/server/admin helpers
- `supabase/migrations/` - database schema
- `scripts/` - one-off operator scripts

## Environment Variables

Copy `.env.example` to `.env.local` and fill in the required values:

```bash
# Defaults for `supabase start` (local Supabase stack)
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=

# Circle dev-controlled wallets
CIRCLE_API_KEY=
CIRCLE_ENTITY_SECRET=
CIRCLE_BLOCKCHAIN=ARC-TESTNET

# Circle App Kit
KIT_KEY=
NEXT_PUBLIC_ARC_CHAIN=Arc_Testnet

# Optional — webhook auth
CIRCLE_WEBHOOK_SECRET=

# Platform fee
APP_FEE_BPS=25
APP_FEE_RECIPIENT=
```

| Variable | Scope | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Public | Supabase project URL. From `npm run db:status` for local dev. |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Public | Supabase publishable key. From `npm run db:status` for local dev. |
| `SUPABASE_SECRET_KEY` | Server-side, secret | Supabase secret key, used only by the admin client; never exposed to the browser. |
| `CIRCLE_API_KEY` | Server-side, secret | Circle Developer-Controlled Wallets API key. |
| `CIRCLE_ENTITY_SECRET` | Server-side, secret | 32-byte hex (64 chars) entity secret. Must be registered with Circle once before use. |
| `CIRCLE_BLOCKCHAIN` | Server-side | Circle blockchain identifier. Defaults to `ARC-TESTNET`. |
| `KIT_KEY` | Server-side, secret | Circle App Kit key used for FX swaps. Being deprecated on the SDK side in favor of a unified `apiKey` field that will accept either a kit key or a plain API key — `KIT_KEY` stays supported until it's removed. |
| `NEXT_PUBLIC_ARC_CHAIN` | Public | App Kit chain identifier. Defaults to `Arc_Testnet`. |
| `CIRCLE_WEBHOOK_SECRET` | Server-side, secret | Optional extra layer. `/api/webhooks/circle` always requires Circle's signature; if this is set, it also requires it as a bearer token. |
| `APP_FEE_BPS` | Server-side | Platform fee in basis points applied to every swap. Defaults to `25` (0.25%). |
| `APP_FEE_RECIPIENT` | Server-side | Address that receives swap fees. Leave blank, then run `npm run wallet:generate` to provision a wallet and auto-fill this value. |

## Testing

```bash
npm test                # unit tests: no network, database or Circle credentials needed
npm run db:start        # local Supabase (Docker)
npm run test:integration  # row level security and swap guards, against the local database
```

The integration tests read `.env.local` (the local Supabase URL and keys). The unit tests cover
input validation, the swap and sign-up server actions, rate limiting, error sanitising and the
webhook, using real EC signatures. Nothing here calls Circle: quotes, swaps and wallet
creation are mocked, so a real swap still has to be tried by hand with your own credentials.

## Upgrading

Apply the new migration to an existing database:

```bash
supabase migration up      # local
supabase db push           # linked project
```

`20260919120000_swap_guards.sql` adds a unique index that allows one pending or submitted swap
per user. If it fails on an existing database, some user has two open swaps: mark the older one
`failed` and run it again. The new checks on amount and wallet address apply to new rows only.

Behaviour changes:
- `/api/webhooks/circle` now requires Circle's signature (`x-circle-signature`, verified with
  the public key fetched using `CIRCLE_API_KEY`). Before, it accepted anyone unless the optional
  bearer secret was set. Register the endpoint in the Circle console as usual; Circle signs
  every notification.
- Swap slippage is capped at 10% (it was 100%), amounts take at most 6 decimals and at most
  1,000,000,000 per swap, and only one swap per user can run at a time.
- Quotes, balance refreshes and sign-ups are rate limited per instance (in memory).
- Wallet addresses are stored lower-case.

## Security & Usage Model

This sample application:
- Assumes testnet usage only, and is not intended for production use without modification
- Handles secrets (`CIRCLE_ENTITY_SECRET`, `SUPABASE_SECRET_KEY`, `KIT_KEY`) via server-only environment variables, never exposed to the client
- Verifies Circle's signature on every webhook, and optionally a shared bearer secret (`CIRCLE_WEBHOOK_SECRET`) on top
- Answers webhooks right away and refreshes the balance afterwards, because Circle gives the endpoint 5 seconds to respond. Circle also publishes the IP addresses its wallet webhooks come from (see its webhook notifications guide); if your host exposes the real client address, you can allowlist them as an extra layer
- Validates every server action input, stores only sanitised errors, and rate limits the calls that spend Circle quota — per server instance, so a multi-instance deployment needs a shared store
- Relies on row level security for reads; all writes go through the server with the secret key
- Sets `X-Content-Type-Options`, `X-Frame-Options` and `Referrer-Policy` on every route, but no Content-Security-Policy
- Provisions the platform fee wallet manually via `npm run wallet:generate`, with no key-rotation flow
