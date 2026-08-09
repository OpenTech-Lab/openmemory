import { NextResponse } from 'next/server';
import { resolveApiToken } from '@/lib/api-token';

const API_URL = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:18080';
type Params = { params: Promise<{ id: string }> };

async function proxy(id: string, method: string, body?: unknown) {
  try {
    const response = await fetch(`${API_URL}/forecast-profiles/${id}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resolveApiToken()}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('forecast-profile proxy error:', error);
    return NextResponse.json({ error: 'Failed to fetch from server' }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: Params) {
  return proxy((await params).id, 'PUT', await request.json());
}
export async function DELETE(_request: Request, { params }: Params) {
  return proxy((await params).id, 'DELETE');
}
