import { handle, httpError } from "@/lib/server/http";
import { ticketContext } from "@/lib/server/ticket-chat";
import { conversationFor, publicConversation, openTicketConversation, masterConversationFor, masterBusy, sendMasterMessage, stopMaster } from "@/lib/server/ticket-conversations";

export async function POST(req: Request) {
  return handle(async () => {
    const host = req.headers.get('host') || '';
    const caller = new URL(`http://${host}`);
    const origin = req.headers.get('origin');
    const site = req.headers.get('sec-fetch-site');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(caller.hostname) || caller.host !== host || (caller.port || '80') !== (process.env.PORT || new URL(req.url).port || '80') || (origin && origin !== caller.origin) || (site && !['same-origin', 'none'].includes(site))) throw httpError(403, 'Local same-origin access only.');
    const body = await req.json() as { ticketId: string; action: string; text?: string; messageId?: string };
    if (!/^[\w-]+$/.test(body.ticketId)) throw httpError(400, 'Invalid ticket.');
    if (body.action === 'open') return Response.json(await openTicketConversation(body.ticketId, caller.origin));
    if (body.action === 'send-master') return Response.json(await sendMasterMessage(body.ticketId, body.text, caller.origin));
    if (body.action === 'stop-master') { stopMaster(body.ticketId); return Response.json({ ok: true }); }
    if (body.action === 'load-master') {
      await ticketContext(body.ticketId);
      const record = masterConversationFor(body.ticketId);
      return Response.json({ messages: record?.messages ?? [], busy: masterBusy(body.ticketId), conversation: publicConversation(record) });
    }
    if (!['load', 'prepare'].includes(body.action)) throw httpError(400, 'Ticket chat now opens in the provider app. Use Open chat.');
    const context = await ticketContext(body.ticketId, body.action === 'prepare');
    return Response.json({ ...context, conversation: publicConversation(conversationFor(body.ticketId)) });
  });
}
