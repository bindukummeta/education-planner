// sync-config.js — PUBLIC values only. The anon key is safe to ship in client
// code; real security comes from Supabase Row Level Security (RLS), not secrecy.
//
// To enable cross-device Family Sync, replace the two placeholders below with the
// Project URL and anon public key from your Supabase project (Project Settings →
// API), then reload. Until real values are set, sync stays OFF and the app runs
// exactly as before (fully offline, IndexedDB-only).
window.EDU_SYNC_CONFIG = {
  url: "https://<your-ref>.supabase.co",
  anonKey: "<your-anon-public-key>",
};
