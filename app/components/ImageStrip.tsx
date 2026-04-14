import type { GeneratedImage } from "@/lib/generatedImage";

export type { GeneratedImage };

export function ImageStrip({ images }: { images: GeneratedImage[] }) {
  return (
    <div className="card" style={{ maxHeight: "78vh", overflow: "auto" }}>
      <strong>Illustrations</strong>
      <small className="muted" style={{ display: "block", marginTop: 4 }}>
        Generated with gpt-image-1 when you click “Generate image”.
      </small>
      <hr />
      {images.length === 0 ? (
        <small className="muted">No images yet.</small>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {images.slice().reverse().map((img, idx) => (
            <div key={idx} style={{ display: "grid", gap: 6 }}>
              <div className="kv">
                <span className="tag">{img.title}</span>
                <small className="muted">{img.at}</small>
              </div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                alt={img.title}
                src={img.imagePath ?? (img.b64 ? `data:image/png;base64,${img.b64}` : "")}
                style={{ width: "100%", borderRadius: 10, border: "1px solid #e5e7eb" }}
              />
              {img.caption ? <small className="muted">{img.caption}</small> : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
