import { AuditTable } from '@/components/audit/AuditTable';

// Rendered per request (the (app) layout is force-dynamic for the CSP nonce).
export const dynamic = 'force-dynamic';

export default async function AuditPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold">Audit Trail</h1>
      <AuditTable sessionId={id} />
    </div>
  );
}
