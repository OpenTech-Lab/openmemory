import { NextResponse } from 'next/server';
import { resolveApiToken } from '@/lib/api-token';

const API_URL = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:18080';
const API_TOKEN = resolveApiToken();

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const { id } = await params;
  try {
    const { searchParams } = new URL(request.url);
    const forwarded = new URLSearchParams();
    const bucket = searchParams.get('bucket');
    const periods = searchParams.get('periods');
    if (bucket) forwarded.set('bucket', bucket);
    if (periods) forwarded.set('periods', periods);
    const qs = forwarded.toString();

    const response = await fetch(`${API_URL}/agents/${id}/stats/timeseries${qs ? `?${qs}` : ''}`, {
      headers: { 'Authorization': `Bearer ${API_TOKEN}` },
    });
    const contentType = response.headers.get('content-type') ?? '';
    const data = contentType.includes('application/json')
      ? await response.json()
      : { error: `Upstream error (${response.status}): ${(await response.text()).slice(0, 200)}` };
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('agents/[id]/stats/timeseries proxy error:', error);
    return NextResponse.json({ error: 'Failed to fetch from server' }, { status: 500 });
  }
}
