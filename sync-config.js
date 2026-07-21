// sync-config.js — PUBLIC values only. The anon key is safe to ship in client
// code; real security comes from Supabase Row Level Security (RLS), not secrecy.
//
// To enable cross-device Family Sync, replace the two placeholders below with the
// Project URL and anon public key from your Supabase project (Project Settings →
// API), then reload. Until real values are set, sync stays OFF and the app runs
// exactly as before (fully offline, IndexedDB-only).
window.EDU_SYNC_CONFIG = {
  url: "https://eaiqziogpqfhvryoclfs.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVhaXF6aW9ncHFmaHZyeW9jbGZzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ2MjU3MzAsImV4cCI6MjEwMDIwMTczMH0.N3BXjzZk7UuPv3_aK4eikrD6ieGBCvwEb5EriKbBT0E",
};
