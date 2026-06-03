import { NextResponse } from 'next/server';
import { resolveApiToken } from '@/lib/api-token';

const API_URL = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8080';
const API_TOKEN = resolveApiToken();
type Params = { params: Promise<{ id: string }> };

function authHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_TOKEN}` };
}

export async function POST(_req: Request, { params }: Params) {
  const { id } = await params;
  try {
    const response = await fetch(`${API_URL}/projects/${id}/routines/check`, { method: 'POST', headers: authHeaders() });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch { return NextResponse.json({ error: 'Failed to fetch from server' }, { status: 500 }); }
}
