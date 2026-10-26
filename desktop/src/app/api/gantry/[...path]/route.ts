import { executionFor } from "@/lib/server/workflow-executor";
import { conversationFor, publicConversation } from "@/lib/server/ticket-conversations";
import { syncGantrySpaces } from "@/lib/server/spaces";
import { ticketOutputs } from "@/lib/server/ticket-outputs";
import type { StatusView } from "@/lib/client/gantry";
import { ticketWorktreeCleanup } from "@/lib/server/worktree-cleanup";

/** Same-origin bridge to the local Gantry service; never accepts an upstream URL. */

type Context = { params: Promise<{ path: string[] }> };
const reads = [
  /^api\/projects\/[\w-]+\/(chat-prompt|workflow|workflow-templates)$/,
  /^api\/tickets\/[\w-]+\/(workflow|worktree-cleanup)$/,
  /^api\/(status|version|vcs)$/,
  /^logs\/(run\/[\w-]+|preview\/[\w-]+\/[\w-]+)$/,
  /^artifacts\/[\w-]+\/[\w.-]+$/,
];
const writes = [
  /^api\/projects$/,
  /^api\/vcs(\/test)?$/,
  /^api\/projects\/[\w-]+\/(refresh|tickets|chat-prompt|workflow|workflow-templates)$/,
  /^api\/projects\/[\w-]+\/workflow-templates\/[\w-]+$/,
  /^api\/projects\/[\w-]+\/tickets\/reorder$/,
  /^api\/tickets\/[\w-]+\/(update|outcome|awaiting-review|delete|prompt|start|handoff|resume|workflow|workflow-progress|worktree-cleanup)$/,
  /^api\/previews\/[\w-]+\/(pause|resume|restart|retry-dependencies|archive|restore|environment)$/,
];

async function proxy(req: Request, context: Context) {
  const host = req.headers.get("host") || "";
  let caller: URL;
  try { caller = new URL(`http://${host}`); } catch { return Response.json({ error: "Invalid local host." }, { status: 403 }); }
  // Next's standalone server may normalize req.url to localhost. Validate the
  // actual Host against its listening port, then compare browser Origin to it.
  const port = process.env.PORT || new URL(req.url).port || "80";
  if (!["localhost", "127.0.0.1", "[::1]"].includes(caller.hostname) || caller.host !== host || (caller.port || "80") !== port || caller.username || caller.password) {
    return Response.json({ error: "Gantry is available only from this local app." }, { status: 403 });
  }
  const origin = req.headers.get("origin");
  const site = req.headers.get("sec-fetch-site");
  if ((origin && origin !== caller.origin) || (site && !["same-origin", "none"].includes(site))) {
    return Response.json({ error: "Cross-origin Gantry access is not allowed." }, { status: 403 });
  }
  const segments = (await context.params).path;
  const route = segments.join("/");
  const allowed = req.method === "GET" ? reads : req.method === "POST" ? writes : [/^api\/projects\/[\w-]+$/];
  if (segments.some((part) => !/^[\w.-]+$/.test(part) || part === "." || part === "..") || !allowed.some((pattern) => pattern.test(route))) {
    return Response.json({ error: "Unsupported Gantry action." }, { status: 404 });
  }
  try {
    const upstream = new URL(process.env.PR_LENS_GANTRY_URL || "http://127.0.0.1:4500");
    if (upstream.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(upstream.hostname) || upstream.username || upstream.password) throw new Error("Invalid local Gantry URL.");
    let body: string | undefined;
    if (req.method !== "GET") {
      if (!req.headers.get("content-type")?.startsWith("application/json")) return Response.json({ error: "JSON is required." }, { status: 415 });
      body = await req.text();
      if (body.length > 1_000_000) return Response.json({ error: "Request is too large." }, { status: 413 });
    }
    const workflowMutation = /^api\/tickets\/([\w-]+)\/(workflow|workflow-progress|start|resume|handoff)$/.exec(route);
    if (req.method === 'POST' && workflowMutation && executionFor(workflowMutation[1])) return Response.json({error:'This ticket is managed by workflow automation. Use its execution controls.'},{status:409});
    const cleanup = /^api\/tickets\/([\w-]+)\/worktree-cleanup$/.exec(route);
    const response = cleanup
      ? await ticketWorktreeCleanup(upstream, cleanup[1], req.method, body)
      : await fetch(new URL(`/${route}`, upstream), {
        method: req.method,
        headers: { "Content-Type": "application/json", Origin: upstream.origin },
        body,
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(60000),
      });
    let responseBody: BodyInit | null = response.body;
    const workflowRead = /^api\/tickets\/([\w-]+)\/workflow$/.exec(route);
    if(req.method==='GET' && workflowRead && response.ok){const execution=executionFor(workflowRead[1]);if(execution){const original=await response.json();responseBody=JSON.stringify({graph:execution.graph,revision:original?.revision??0,states:Object.fromEntries(Object.entries(execution.steps).map(([id,state])=>[id,{state,message:execution.attempts.filter(a=>a.nodeId===id).at(-1)?.summary||''}]))});}}

    if (route === "api/status" && response.ok) {
      const status = await response.json() as StatusView;
      // PRs a stage reported join the ticket's review space alongside those found on its branch.
      for (const t of status.tickets) {
        const reported = executionFor(t.id)?.deliverables ?? [];
        for (const d of reported) if (!t.pullRequests.some(p => p.url === d.url)) t.pullRequests.push({ role: 'agent', number: Number(d.url.split('/').at(-1)) || 0, url: d.url, title: d.title });
      }
      // Extra outputs are a convenience: finding them must never break the board.
      let outputs: ReturnType<typeof ticketOutputs> = {};
      try { outputs = ticketOutputs(status, id => executionFor(id)?.deliverables ?? []); } catch (error) { console.error("[gantry] Could not list ticket outputs.", error); }
      const spaces = syncGantrySpaces(status, outputs);
      responseBody = JSON.stringify({ ...status, tickets: status.tickets.map(t => { const execution=executionFor(t.id); return { ...t, ...(execution ? {workflow:{graph:execution.graph,revision:t.workflow?.revision??0,states:Object.fromEntries(Object.entries(execution.steps).map(([id,state])=>[id,{state,message:execution.attempts.filter(a=>a.nodeId===id).at(-1)?.summary||''}]))},execution:{activeNodeId:execution.activeNodeId,state:execution.state,message:execution.message,updatedAt:execution.updatedAt,decision:execution.decision,deliverables:execution.deliverables}} : {}), reviewSpaceId: spaces[t.id], conversation: publicConversation(conversationFor(t.id)) }; }) });
    }
    return new Response(responseBody, {
      status: response.status,
      headers: {
        "Content-Type": response.headers.get("content-type") || "application/json",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if ((error as { status?: number }).status === 409) return Response.json({ error: (error as Error).message }, { status: 409 });
    return Response.json({ error: "Gantry is unavailable. Reopen the desktop app, or start Gantry and retry." }, { status: 503 });
  }
}

export { proxy as GET, proxy as POST, proxy as DELETE };
