import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

/** 在浏览器本地生成授权二维码，授权链接不会发送给制码服务。 */
export function LoginQr({ url, label }: { url: string; label: string }) {
  const [image, setImage] = useState<string>()
  useEffect(() => {
    let active = true
    setImage(undefined)
    if (!url.startsWith('https://')) return
    void QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 208 })
      .then((value) => { if (active) setImage(`data:image/svg+xml,${encodeURIComponent(value)}`) })
      .catch(() => { if (active) setImage(undefined) })
    return () => { active = false }
  }, [url])
  return image ? <img className="agent-kit-login-qr" src={image} alt={label} width={208} height={208} /> : null
}
