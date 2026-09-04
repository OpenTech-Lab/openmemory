import { NextResponse } from 'next/server';
import { resolveApiToken } from '@/lib/api-token';

const API_URL = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:18080';
const API_TOKEN = resolveApiToken();

type Params = { params: Promise<{ id: string; planId: string }> };

function authHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${API_TOKEN}`,
  };
}

export async function POST(_req: Request, { params }: Params) {
  const { id, planId } = await params;
  try {
    // A plan run is a test suite: it can legitimately take minutes, so this
    // proxy must not impose a shorter deadline than the server's own timeout.
    const response = await fetch(`${API_URL}/projects/${id}/qa/plans/${planId}/run`, {
      method: 'POST',
      headers: authHeaders(),
    });
    const contentType = response.headers.get('content-type') ?? '';
    const data = contentType.includes('application/json')
      ? await response.json()
      : { error: `Upstream error (${response.status}): ${(await response.text()).slice(0, 200)}` };
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('projects/[id]/qa/plans/[planId]/run proxy error:', error);
    return NextResponse.json({ error: 'Failed to reach the server' }, { status: 500 });
  }
}
