// Who may turn a Mail account into a ticket inbox (contracts/collab.md "Using an account for
// tickets"): a workspace admin, for an account they connected themselves.

import type { MailAccount } from "@/lib/api/types";
import { atLeast, useRole, useSession } from "@/lib/session";

export function useCanHandOver(account: Pick<MailAccount, "owner"> | undefined): boolean {
  const role = useRole();
  const me = useSession((s) => s.user?.id ?? "");
  return atLeast(role, "admin") && !!me && account?.owner?.id === me;
}
