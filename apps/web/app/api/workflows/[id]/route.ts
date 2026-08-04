import { NextResponse } from 'next/server';
import { resolveApiToken } from '@/lib/api-token';

const API_URL = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:18080';
const API_TOKEN = resolveApiToken();

async function proxy(id: string, method: string, body?: unknown) {
  try {
    const response = await fetch(`${API_URL}/workflows/${encodeURIComponent(id)}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_TOKEN}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch {
    return NextResponse.json({ error: 'Failed to fetch from server' }, { status: 500 });
  }
}

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) { return proxy((await params).id, 'GET'); }
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) { return proxy((await params).id, 'PUT', await request.json()); }
export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) { return proxy((await params).id, 'DELETE'); }
