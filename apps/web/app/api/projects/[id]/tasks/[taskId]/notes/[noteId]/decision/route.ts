import { NextResponse } from 'next/server';
import { resolveApiToken } from '@/lib/api-token';

const API_URL = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:18080';
const API_TOKEN = resolveApiToken();

type Params = { params: Promise<{ id: string; taskId: string; noteId: string }> };

export async function POST(req: Request, { params }: Params) {
  const { id, taskId, noteId } = await params;
  try {
    const response = await fetch(`${API_URL}/projects/${id}/tasks/${taskId}/notes/${noteId}/decision`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify(await req.json()),
    });
    const contentType = response.headers.get('content-type') ?? '';
    const data = contentType.includes('application/json')
      ? await response.json()
      : { error: `Upstream error (${response.status}): ${(await response.text()).slice(0, 200)}` };
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('task decision proxy error:', error);
    return NextResponse.json({ error: 'Failed to resolve task decision' }, { status: 500 });
  }
}
