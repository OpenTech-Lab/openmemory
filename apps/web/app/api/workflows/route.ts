import { NextResponse } from 'next/server';
import { resolveApiToken } from '@/lib/api-token';

const API_URL = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:18080';
const API_TOKEN = resolveApiToken();

async function proxy(method: string, body?: unknown) {
  try {
    const response = await fetch(`${API_URL}/workflows`, {
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

export function GET() { return proxy('GET'); }
export async function POST(request: Request) { return proxy('POST', await request.json()); }
