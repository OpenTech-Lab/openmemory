import { NextResponse, NextRequest } from 'next/server';
import { resolveApiToken } from '@/lib/api-token';

const API_URL = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:18080';
const API_TOKEN = resolveApiToken();

type Params = { params: Promise<{ id: string }> };

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
    console.error('projects/[id]/qa/plans proxy error:', error);
    return NextResponse.json({ error: 'Failed to fetch from server' }, { status: 500 });
  }
}

export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const search = req.nextUrl.search;
  return proxy(`${API_URL}/projects/${id}/qa/plans${search}`, 'GET');
}

export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  const body = await req.json();
  return proxy(`${API_URL}/projects/${id}/qa/plans`, 'POST', body);
}
