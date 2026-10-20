// Moderator sign-in for the review UI (admin.html): email + password, or an
// email magic link.
//
// shouldCreateUser: false — this form only signs in accounts that already
// exist. Moderator accounts are created by invite from the Supabase dashboard
// (Authentication → Users → Invite), then promoted by hand with
// `update profiles set role = 'moderator' where id = '...'` (see schema.sql).
// The public never needs an account: crowdsourced submissions go in as anon.
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

export async function sendMagicLink(email: string): Promise<void> {
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: false,
      // Must be allow-listed in Authentication → URL Configuration.
      emailRedirectTo: `${window.location.origin}/admin.html`,
    },
  });
  if (error) throw new Error(`sendMagicLink failed: ${error.message}`);
}

// Password sign-in, for accounts created in the dashboard with a password
// (Authentication → Users → Add user → Create new user, "Auto Confirm User"
// ticked). Needs no email delivery, so it also works for a local/dev
// moderator address that isn't a real mailbox.
export async function signInWithPassword(email: string, password: string): Promise<void> {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`Sign-in failed: ${error.message}`);
}

export async function signOut(): Promise<void> {
  const { error } = await supabase.auth.signOut();
  if (error) throw new Error(`signOut failed: ${error.message}`);
}

export async function getSession(): Promise<Session | null> {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export function onSessionChange(cb: (session: Session | null) => void): void {
  supabase.auth.onAuthStateChange((_event, session) => cb(session));
}

// UI hint only — it decides whether to show the queue. The actual
// enforcement is RLS + the check inside review_incident().
export async function isModerator(): Promise<boolean> {
  const { data, error } = await supabase.rpc('is_moderator');
  if (error) throw new Error(`isModerator failed: ${error.message}`);
  return data === true;
}
