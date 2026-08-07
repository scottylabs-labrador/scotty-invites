import { useEffect, useState } from "react";
import QRCode from "qrcode";

export function QrCode({ value, size = 150 }: { value: string; size?: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(value, { width: size * 2, margin: 0, color: { dark: "#0a0a0aff", light: "#ffffffff" } }).then(
      (u) => {
        if (!cancelled) setUrl(u);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [value, size]);
  if (!url) return <div style={{ width: size, height: size }} />;
  return <img src={url} width={size} height={size} style={{ display: "block" }} alt={`QR code ${value}`} />;
}
