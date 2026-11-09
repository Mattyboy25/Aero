// The signed-in user. Nothing authenticates yet, so this returns a guest.
// When real sign-in exists, return the account here (from your auth provider or an API call)
// and everything that shows the user (the sidebar, the settings modal) updates with it.

export interface User {
  name: string;
  /** Shown under the name. */
  email?: string;
  avatarUrl?: string;
}

export interface UserState {
  user: User;
  signedIn: boolean;
}

const GUEST: User = { name: "Guest", email: "Not signed in" };

export function useUser(): UserState {
  return { user: GUEST, signedIn: false };
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] ?? "?").slice(0, 2);
  return letters.toUpperCase();
}
