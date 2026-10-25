import { assistGraph } from '@/lib/server/graph-assistant';
import { handle, httpError, requireLocalMutation } from '@/lib/server/http';

export async function POST(req: Request) {
  return handle(async () => {
    requireLocalMutation(req);
    const text = await req.text();
    if (text.length > 1000000) throw httpError(413, 'Graph requests must be smaller than 1 MB.');

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw httpError(400, 'Expected a JSON graph request.');
    }

    return Response.json(await assistGraph(body, req.signal));
  });
}
