import { NextResponse } from 'next/server';
import { resolveApiToken } from '@/lib/api-token';

const API_URL = process.env.API_URL || process.env.NEXT_PUBLIC_API_URL || 'http://127.0.0.1:18080';
type Params = { params: Promise<{ id: string; designId: string; budgetId: string }> };

async function proxy(url: string, method: string, body?: unknown) {
  try {
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resolveApiToken()}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    console.error('design budget proxy error:', error);
    return NextResponse.json({ error: 'Failed to fetch from server' }, { status: 500 });
  }
}

export async function PUT(request: Request, { params }: Params) {
  const { id, designId, budgetId } = await params;
  return proxy(`${API_URL}/projects/${id}/designs/${designId}/budgets/${budgetId}`, 'PUT', await request.json());
}

export async function DELETE(_request: Request, { params }: Params) {
  const { id, designId, budgetId } = await params;
  return proxy(`${API_URL}/projects/${id}/designs/${designId}/budgets/${budgetId}`, 'DELETE');
}
