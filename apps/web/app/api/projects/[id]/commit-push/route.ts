import { NextResponse, NextRequest } from 'next/server';
import { resolveApiToken } from '@/lib/api-token';

const API_URL = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:18080';
const API_TOKEN = resolveApiToken();

type Params = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Params) {
  const { id } = await params;
  try {
    const body = await request.json();
    const response = await fetch(`${API_URL}/projects/${id}/commit-push`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_TOKEN}`,
      },
      body: JSON.stringify(body),
    });
    const contentType = response.headers.get('content-type') ?? '';
    const data = contentType.includes('application/json')
      ? await response.json()
      : { error: `Upstream error (${response.status}): ${(await response.text()).slice(0, 200)}` };
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('projects/[id]/commit-push proxy error:', error);
    return NextResponse.json({ error: 'Failed to commit and push changes' }, { status: 500 });
  }
}
