import { NextResponse, NextRequest } from 'next/server';
import { resolveApiToken } from '@/lib/api-token';

const API_URL = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:18080';
const API_TOKEN = resolveApiToken();

// Forwards a raw-bytes file upload straight through to the backend's
// POST /library/upload, passing the `?ext=` query param along so the backend
// can name the stored blob with the right extension. Returns the backend's
// `{ location }` JSON response unchanged.
export async function POST(req: NextRequest) {
  const search = req.nextUrl.search;
  try {
    const body = await req.arrayBuffer();
    const response = await fetch(`${API_URL}/library/upload${search}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Authorization': `Bearer ${API_TOKEN}`,
      },
      body,
    });
    const contentType = response.headers.get('content-type') ?? '';
    const data = contentType.includes('application/json')
      ? await response.json()
      : { error: `Upstream error (${response.status}): ${(await response.text()).slice(0, 200)}` };
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('library/upload proxy error:', error);
    return NextResponse.json({ error: 'Failed to fetch from server' }, { status: 500 });
  }
}
