import { NextResponse } from 'next/server';
import { resolveApiToken } from '@/lib/api-token';

const API_URL = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:18080';

async function proxy(method: string, body?: unknown) {
  try {
    const response = await fetch(`${API_URL}/forecast-profiles`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resolveApiToken()}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('forecast-profiles proxy error:', error);
    return NextResponse.json({ error: 'Failed to fetch from server' }, { status: 500 });
  }
}

export async function GET() { return proxy('GET'); }
export async function POST(request: Request) { return proxy('POST', await request.json()); }
