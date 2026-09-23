# Arc Stablecoin FX

This sample app demonstrates stablecoin FX swaps between USDC and EURC using the App Kits Swap SDK and Circle Developer Controlled Wallets on Arc.

<img alt="Arc Stablecoin Fx" src="public/screenshot.png" />

## Getting started

### Prerequisites

- Node.js 20+ and npm
- Docker (for local Supabase)
- A [Circle](https://console.circle.com) account with API key + entity secret. The same API key authenticates App Kit swaps

### 1. Install dependencies

```sh
npm install
```

### 2. Start the local Supabase stack

```sh
npm run db:start
```

This boots Postgres, Auth, etc. via the Supabase CLI and runs the migrations in
`supabase/migrations/`. Use `npm run db:status` to print the local URLs and keys,
`npm run db:reset` to wipe + re-migrate, and `npm run db:stop` to shut it down.

### 3. Configure environment

Copy the example file and fill in the blanks:

```sh
cp .env.example .env.local
```

- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` /
`SUPABASE_SECRET_KEY` - from `npm run db:status`.
- `CIRCLE_API_KEY` - from the Circle console.
- `CIRCLE_ENTITY_SECRET` - your 32-byte hex entity secret. Must be registered
with Circle once before use.
- `CIRCLE_BLOCKCHAIN` - Circle blockchain identifier (default `ARC-TESTNET`).
- `NEXT_PUBLIC_ARC_CHAIN` - App Kit chain identifier (default `Arc_Testnet`).
- `CIRCLE_WEBHOOK_SECRET` - optional. If set, `/api/webhooks/circle` also requires it as a bearer token on top of Circle's signature.
- `APP_FEE_BPS` - platform fee in basis points (default `25` = 0.25%).
- `APP_FEE_RECIPIENT` - leave blank, then run the script below.

### 4. Provision the platform fee wallet

Creates a Circle wallet to receive swap fees and writes its address back to
`.env.local` as `APP_FEE_RECIPIENT`:

```sh
npm run wallet:generate
```

### 5. Run the dev server

```sh
npm run dev
```

App is running at [http://localhost:3000](http://localhost:3000).

## Project layout

- `src/app/(auth)/` - register / login flows
- `src/app/(app)/dashboard/` - authenticated swap panel
- `src/app/(app)/dashboard/history/` - trades history
- `src/app/api/webhooks/circle/` - Circle webhook receiver
- `src/components/swap/`, `src/components/trades/`, `src/components/wallet/` - feature UI
- `src/lib/circle/`, `src/lib/appkit/` - Circle wallets + App Kit integration
- `src/lib/supabase/` - Supabase client/server/admin helpers
- `supabase/migrations/` - database schema
- `scripts/` - one-off operator scripts

## Testing

```sh
npm test                  # unit tests: no network, database or Circle credentials needed
npm run db:start          # local Supabase (Docker)
npm run test:integration  # row level security and swap guards, against the local database
```

Nothing here calls Circle: quotes, swaps and wallet creation are mocked, so a real swap still has to be tried by hand with your own credentials.

## Legal

Sample apps provided for demonstration and educational purposes only, intended for Arc testnet use only, and not production-ready. See [Arc.io](https://arc.io) for more.
