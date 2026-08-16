import { NextResponse, NextRequest } from 'next/server';
import { resolveApiToken } from '@/lib/api-token';

const API_URL = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:18080';
const API_TOKEN = resolveApiToken();

async function proxy(url: string, method: string, body?: unknown) {
  try {
    const response = await fetch(url, {
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

export function GET(req: NextRequest) {
  const search = req.nextUrl.search;
  return proxy(`${API_URL}/workflows${search}`, 'GET');
}
export async function POST(request: Request) {
  return proxy(`${API_URL}/workflows`, 'POST', await request.json());
}
