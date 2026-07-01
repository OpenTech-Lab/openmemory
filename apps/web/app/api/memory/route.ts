import { NextResponse } from 'next/server';
import { resolveApiToken } from '@/lib/api-token';

const API_URL = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:18080';
const API_TOKEN = resolveApiToken();

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Endpoints that require Bearer auth on the backend
    const AUTH_REQUIRED = new Set([
      'env.get',
      'graph.set_llm_config',
      'graph.analyze_all',
    ]);
    if (body?.type && AUTH_REQUIRED.has(body.type)) {
      headers['Authorization'] = `Bearer ${API_TOKEN}`;
    }

    const response = await fetch(`${API_URL}/mcp`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    // Surface the upstream status; handle non-JSON bodies (e.g. 502 gateway HTML) gracefully
    let data: unknown;
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      data = await response.json();
    } else {
      const text = await response.text();
      data = { error: `Upstream error (${response.status}): ${text.slice(0, 200)}` };
    }
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('API error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch from server' },
      { status: 500 }
    );
  }
}
