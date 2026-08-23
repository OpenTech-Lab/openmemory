import { NextResponse, NextRequest } from 'next/server';
import { resolveApiToken } from '@/lib/api-token';

const API_URL = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:18080';
const API_TOKEN = resolveApiToken();

type Params = { params: Promise<{ id: string; evidenceId: string }> };

// Unlike the other qa proxy routes, this streams raw bytes (the evidence
// image) instead of JSON — modelled on library/[entryId]/file and
// library/upload rather than the JSON proxy() helper used everywhere else
// under projects/[id]/qa. Going through that helper's JSON.parse would mangle
// the image bytes.
export async function GET(_req: Request, { params }: Params) {
  const { id, evidenceId } = await params;
  try {
    const response = await fetch(`${API_URL}/projects/${id}/qa/evidence/${evidenceId}/blob`, {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });

    if (!response.ok) {
      const contentType = response.headers.get('content-type') ?? '';
      const data = contentType.includes('application/json')
        ? await response.json()
        : { error: `Upstream error (${response.status}): ${(await response.text()).slice(0, 200)}` };
      return NextResponse.json(data, { status: response.status });
    }

    return new NextResponse(response.body, {
      status: response.status,
      headers: {
        'Content-Type': response.headers.get('Content-Type') ?? 'application/octet-stream',
      },
    });
  } catch (error) {
    console.error('projects/[id]/qa/evidence/[evidenceId]/blob GET proxy error:', error);
    return NextResponse.json({ error: 'Failed to fetch from server' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: Params) {
  const { id, evidenceId } = await params;
  try {
    const body = await req.arrayBuffer();
    const response = await fetch(`${API_URL}/projects/${id}/qa/evidence/${evidenceId}/blob`, {
      method: 'PUT',
      headers: {
        'Content-Type': req.headers.get('content-type') ?? 'application/octet-stream',
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
    console.error('projects/[id]/qa/evidence/[evidenceId]/blob PUT proxy error:', error);
    return NextResponse.json({ error: 'Failed to fetch from server' }, { status: 500 });
  }
}
