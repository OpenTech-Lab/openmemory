import { NextResponse } from 'next/server';
import { resolveApiToken } from '@/lib/api-token';

const API_URL = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:18080';
const API_TOKEN = resolveApiToken();

type Params = { params: Promise<{ id: string; designId: string }> };

function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${API_TOKEN}`,
  };
}

async function proxy(url: string, method: string, body?: unknown) {
  try {
    const response = await fetch(url, {
      method,
      headers: authHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const contentType = response.headers.get('content-type') ?? '';
    const data = contentType.includes('application/json')
      ? await response.json()
      : { error: `Upstream error (${response.status}): ${(await response.text()).slice(0, 200)}` };
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('projects/[id]/designs/[designId]/revisions proxy error:', error);
    return NextResponse.json({ error: 'Failed to fetch from server' }, { status: 500 });
  }
}

export async function GET(_req: Request, { params }: Params) {
  const { id, designId } = await params;
  return proxy(`${API_URL}/projects/${id}/designs/${designId}/revisions`, 'GET');
}

/** Explicit labelled snapshot. Unlike the automatic pre-save snapshots the server cuts during an
 * update, this one always writes — the body carries the label the user typed. */
export async function POST(req: Request, { params }: Params) {
  const { id, designId } = await params;
  const body = await req.json();
  return proxy(`${API_URL}/projects/${id}/designs/${designId}/revisions`, 'POST', body);
}
