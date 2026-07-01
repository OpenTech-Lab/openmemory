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

export async function GET(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const search = req.nextUrl.search;
  try {
    const response = await fetch(`${API_URL}/projects/${id}/query${search}`, {
      method: 'GET',
      headers: authHeaders(),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('projects/[id]/query proxy error:', error);
    return NextResponse.json({ error: 'Failed to fetch from server' }, { status: 500 });
  }
}
