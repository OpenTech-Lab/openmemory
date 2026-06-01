import { NextResponse } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8080';

type Params = { params: Promise<{ id: string }> };

async function proxyAgent(id: string, method: string, body?: unknown) {
  try {
    const response = await fetch(`${API_URL}/agents/${id}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const contentType = response.headers.get('content-type') ?? '';
    const data = contentType.includes('application/json')
      ? await response.json()
      : { error: `Upstream error (${response.status}): ${(await response.text()).slice(0, 200)}` };
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('agents/[id] proxy error:', error);
    return NextResponse.json({ error: 'Failed to fetch from server' }, { status: 500 });
  }
}

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  return proxyAgent(id, 'GET');
}

export async function PUT(request: Request, { params }: Params) {
  const { id } = await params;
  const body = await request.json();
  return proxyAgent(id, 'PUT', body);
}

export async function DELETE(_req: Request, { params }: Params) {
  const { id } = await params;
  return proxyAgent(id, 'DELETE');
}
