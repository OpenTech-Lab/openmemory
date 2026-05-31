import { NextResponse } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:8080';
const API_TOKEN = process.env.OPENMEMORY_API_TOKEN || 'dev-token-change-me';

export async function POST(request: Request) {
  try {
    const body = await request.json();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    // Inject auth token only for env.get — the only endpoint that checks it (secret reads).
    // Write ops (env.set, env.delete, env.list) are intentionally open; no token needed.
    if (body?.type === 'env.get') {
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
