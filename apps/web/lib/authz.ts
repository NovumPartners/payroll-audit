/**
 * Capabilities, not role strings. Pages and actions ask `can(user, capability, clientId?)`.
 * Lead: everything, including configuration. Specialist: assigned clients only.
 * Reviewer: read-only across clients. No role can submit payroll; the system
 * only records that a person submitted in the platform.
 */
export type Role = "lead" | "specialist" | "reviewer";

export interface User {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export type Capability =
  | "view_queue"
  | "view_all_clients"
  | "decide_exception"
  | "rerun_qa"
  | "send_preview"
  | "record_approval"
  | "mark_submitted"
  | "apply_request"
  | "resolve_question"
  | "sign_profile"
  | "draft_profile"
  | "admin";

const LEAD: Capability[] = ["view_queue", "view_all_clients", "decide_exception", "rerun_qa", "send_preview", "record_approval", "mark_submitted", "apply_request", "resolve_question", "sign_profile", "draft_profile", "admin"];
const SPECIALIST: Capability[] = ["view_queue", "decide_exception", "rerun_qa", "send_preview", "record_approval", "mark_submitted", "apply_request", "resolve_question", "sign_profile", "draft_profile"];
const REVIEWER: Capability[] = ["view_queue", "view_all_clients"];

export const CAPABILITIES: Record<Role, Capability[]> = { lead: LEAD, specialist: SPECIALIST, reviewer: REVIEWER };

/** `assigned` is whether the client in question is assigned to this user; a specialist acts on assigned clients only. */
export function can(user: Pick<User, "role">, capability: Capability, assigned?: boolean): boolean {
  if (!CAPABILITIES[user.role].includes(capability)) return false;
  if (user.role === "specialist" && capability !== "view_queue" && assigned === false) return false;
  return true;
}

/** A specialist may read assigned clients; a lead or reviewer reads all. */
export function canView(user: Pick<User, "role">, assigned: boolean): boolean {
  return user.role !== "specialist" || assigned;
}
