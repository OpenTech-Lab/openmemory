import { NextResponse } from 'next/server';
import { resolveApiToken } from '@/lib/api-token';

const API_URL = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8080';
const API_TOKEN = resolveApiToken();
type Params = { params: Promise<{ id: string }> };

function authHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_TOKEN}` };
}
async function proxy(url: string, method: string, body?: unknown) {
  try {
    const response = await fetch(url, { method, headers: authHeaders(), body: body !== undefined ? JSON.stringify(body) : undefined });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch { return NextResponse.json({ error: 'Failed to fetch from server' }, { status: 500 }); }
}

export async function GET(_req: Request, { params }: Params) {
  const { id } = await params;
  return proxy(`${API_URL}/projects/${id}/routines`, 'GET');
}
export async function POST(req: Request, { params }: Params) {
  const { id } = await params;
  return proxy(`${API_URL}/projects/${id}/routines`, 'POST', await req.json());
}
