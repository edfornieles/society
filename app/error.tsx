"use client";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="gameRoot" style={{ padding: 24, maxWidth: 560 }}>
      <h1 style={{ fontSize: 14, marginBottom: 12 }}>Something went wrong</h1>
      <pre
        style={{
          fontSize: 11,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          padding: 12,
          border: "2px solid #55321d",
          background: "#f7e2c9",
        }}
      >
        {error.message}
        {error.digest ? `\n(digest: ${error.digest})` : ""}
      </pre>
      <button type="button" style={{ marginTop: 12 }} onClick={() => reset()}>
        Try again
      </button>
    </main>
  );
}
