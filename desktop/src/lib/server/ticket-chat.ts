import "server-only";
import { httpError } from "./http";

export interface TicketWorkspace {
  prompt?: string;
  stagePrompt?: string;
  ticket: { id: string; title: string; assistant_name?: string; description: string; branch: string; status: string; additions: string | null };
  project: { id: string; name: string; workspace: string };
  checkouts: { repositoryId: string; path: string }[];
}
export async function ticketContext(ticketId: string, prepare = false): Promise<TicketWorkspace> {
  if (!/^[\w-]+$/.test(ticketId)) throw httpError(400, "Invalid ticket.");
  const base = new URL(process.env.PR_LENS_GANTRY_URL || "http://127.0.0.1:4500");
  if (base.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)) throw httpError(500, "Invalid Gantry address.");
  const response = await fetch(new URL(`/api/tickets/${ticketId}/${prepare ? "prepare" : "workspace"}`, base), {
    method: prepare ? "POST" : "GET", headers: { "Content-Type": "application/json", Origin: base.origin },
    ...(prepare ? { body: "{}" } : {}), cache: "no-store", signal: AbortSignal.timeout(180000),
  });
  const body = await response.json();
  if (!response.ok) throw httpError(response.status, body.error || "Could not prepare this ticket.");
  return body;
}
