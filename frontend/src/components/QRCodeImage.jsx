import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/*
 * Renders `value` as a QR code (PNG data URL). Keeps it dependency-light:
 * the `qrcode` lib draws to a data URL we drop into an <img>, so there's no
 * canvas ref juggling and it scales crisply on mobile.
 */
export function QRCodeImage({ value, size = 200 }) {
  const [dataUrl, setDataUrl] = useState(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(false);
    QRCode.toDataURL(value, {
      width: size * 2,           // 2x for retina crispness; CSS scales down
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#14202b', light: '#ffffff' },
    })
      .then((url) => { if (!cancelled) setDataUrl(url); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [value, size]);

  if (error) return <p className="small muted">Could not render QR code.</p>;
  if (!dataUrl) return <div className="spinner" aria-hidden="true" />;
  return <img src={dataUrl} alt="Join QR code" width={size} height={size} />;
}
