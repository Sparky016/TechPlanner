// Shows a human-readable error and its correlation ID (§8).
export function ErrorBanner({ message, correlationId }: { message: string; correlationId?: string }) {
  return (
    <div role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-900">
      <p>{message}</p>
      {correlationId ? (
        <p className="mt-1 text-xs text-red-700">
          Correlation ID: <code>{correlationId}</code>
        </p>
      ) : null}
    </div>
  );
}
