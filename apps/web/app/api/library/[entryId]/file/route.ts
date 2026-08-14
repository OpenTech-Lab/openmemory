import { NextResponse } from 'next/server';
import { resolveApiToken } from '@/lib/api-token';

const API_URL = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:18080';
const API_TOKEN = resolveApiToken();

type Params = { params: Promise<{ entryId: string }> };

// Unlike the other library proxy routes, this streams raw bytes (image/video/html)
// instead of JSON, and follows the backend's redirect for URL-backed entries
// (manual mode so we can pass a same-origin-safe redirect back to the browser
// rather than the fetch client silently following it and buffering the bytes).
export async function GET(_req: Request, { params }: Params) {
  const { entryId } = await params;
  try {
    const response = await fetch(`${API_URL}/library/${entryId}/file`, {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
      redirect: 'manual',
    });

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (location) {
        return NextResponse.redirect(location, response.status);
      }
    }

    return new NextResponse(response.body, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('Content-Type') ?? 'application/octet-stream',
      },
    });
  } catch (error) {
    console.error('library/[entryId]/file proxy error:', error);
    return NextResponse.json({ error: 'Failed to fetch from server' }, { status: 500 });
  }
}
