-- Guards for the swap flow. Additive: nothing is dropped or rewritten.

-- 1. One in-flight swap per user. The server action relied on nothing to stop a user firing many
--    swaps at once (double click, scripted calls), each spending the same balance and calling
--    Circle. The action now inserts a 'pending' row first; this index makes a second concurrent
--    insert fail with a unique violation (23505), which the action reports as "in progress".
--    Stale rows are expired by the action, so a crash cannot lock a user out for good.
--    If this fails on an existing database, there are users with two open swaps: mark the older
--    ones 'failed' first.
create unique index if not exists swaps_one_inflight_per_user
  on public.swaps (user_id)
  where status in ('pending', 'submitted');

-- 2. Same upper bound the server enforces on the amount (1,000,000,000). NOT VALID: applies to
--    new rows only, so old data cannot block the migration.
alter table public.swaps
  add constraint swaps_amount_in_max check (amount_in <= 1000000000) not valid;

-- 3. Wallet addresses are stored lower-case (the unique index is already on lower(...)) and the
--    webhook matches them case-insensitively. NOT VALID for the same reason as above.
alter table public.profiles
  add constraint profiles_wallet_address_format
  check (wallet_address ~ '^0x[0-9a-f]{40}$') not valid;

-- 4. Users only ever read these tables from the browser: every write goes through the server
--    with the secret key. RLS already denies writes (there is no insert/update/delete policy);
--    dropping the grants means a future, mistaken policy cannot silently open them up.
revoke insert, update, delete, truncate on table public.profiles from authenticated;
revoke insert, update, delete, truncate on table public.swaps from authenticated;
revoke insert, update, delete, truncate on table public.wallet_balances from authenticated;
