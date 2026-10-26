import { handle, httpError, requireLocalMutation } from '@/lib/server/http';
import { saveVoiceSettings, transcribe, voiceSettings } from '@/lib/server/voice';

export async function POST(req: Request) {
  return handle(async () => {
    requireLocalMutation(req);
    if (req.headers.get('content-type')?.startsWith('multipart/form-data')) {
      if (Number(req.headers.get('content-length')) > 16 * 1024 * 1024) throw httpError(413, 'Recording is too large.');
      const form = await req.formData();
      const audio = form.get('file');
      if (!(audio instanceof File)) throw httpError(400, 'Audio file is required.');
      return Response.json(await transcribe(audio, req.signal));
    }
    const body = await req.json();
    if (body.action === 'load') return Response.json(voiceSettings());
    if (body.action === 'save') return Response.json(saveVoiceSettings(body));
    throw httpError(400, 'Unknown voice action.');
  });
}
